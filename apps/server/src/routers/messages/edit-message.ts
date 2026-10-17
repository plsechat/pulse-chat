import {
  MAX_MESSAGE_CONTENT_LENGTH,
  MAX_MESSAGE_WIRE_LENGTH
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { getMessageInActiveServer } from '../../db/queries/messages';
import { messages } from '../../db/schema';
import { parseMentionedUserIds } from '../../helpers/parse-mentions';
import { eventBus } from '../../plugins/event-bus';
import { enqueueProcessMetadata } from '../../queues/message-metadata';
import { relayAnnouncement } from '../../utils/announcement-follow';
import { checkAutomod, executeAutomodActions } from '../../utils/automod';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const editMessageRoute = serverProcedure()
  .input(
    z.object({
      messageId: z.number().int().positive(),
      content: z
        .string()
        .max(MAX_MESSAGE_WIRE_LENGTH, 'Message is too long')
        .optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const message = await getMessageInActiveServer(
      input.messageId,
      ctx.activeServerId
    );

    invariant(message, {
      code: 'NOT_FOUND',
      message: 'Message not found'
    });

    invariant(message.editable, {
      code: 'FORBIDDEN',
      message: 'This message is not editable'
    });

    invariant(message.userId === ctx.user.id, {
      code: 'FORBIDDEN',
      message: 'You do not have permission to edit this message'
    });

    const updateSet: Record<string, unknown> = {
      edited: true,
      updatedAt: Date.now()
    };

    if (message.e2ee) {
      invariant(input.content, {
        code: 'BAD_REQUEST',
        message: 'E2EE messages must be edited with content'
      });
      updateSet.content = input.content;
    } else {
      invariant(input.content, {
        code: 'BAD_REQUEST',
        message: 'Non-E2EE messages must be edited with content'
      });

      // Same plaintext budget as sending — the wire cap is for ciphertext.
      invariant(input.content.length <= MAX_MESSAGE_CONTENT_LENGTH, {
        code: 'BAD_REQUEST',
        message: 'Message is too long'
      });

      // An edit is a second chance to publish blocked content; run the
      // same rules (and the same actions) as the send path.
      const automodResult = await checkAutomod(
        input.content,
        message.channelId,
        ctx.userId,
        ctx.activeServerId
      );

      if (automodResult.blocked && automodResult.actions) {
        await executeAutomodActions(automodResult.actions, {
          channelId: message.channelId,
          userId: ctx.userId,
          content: input.content,
          serverId: ctx.activeServerId,
          ruleName: automodResult.matchedRuleName ?? 'Unknown',
          authorId: automodResult.matchedRuleCreatedBy
        });

        ctx.throwValidationError(
          'automod',
          'Message blocked by auto-moderation.'
        );
      }

      updateSet.content = input.content;

      // Re-parse mentions on edit
      const memberIds = await getAffectedUserIdsForChannel(message.channelId);
      const parsed = await parseMentionedUserIds(input.content, memberIds);
      updateSet.mentionedUserIds =
        parsed.userIds.length > 0 ? parsed.userIds : null;
      updateSet.mentionsAll = parsed.mentionsAll;
    }

    await db
      .update(messages)
      .set(updateSet)
      .where(eq(messages.id, input.messageId));

    publishMessage(input.messageId, message.channelId, 'update');
    // Copies in follower channels track the edit (no-op elsewhere).
    void relayAnnouncement(input.messageId, 'update');

    if (!message.e2ee && input.content) {
      enqueueProcessMetadata(input.content, input.messageId);

      eventBus.emit('message:updated', {
        messageId: input.messageId,
        channelId: message.channelId,
        userId: message.userId,
        content: input.content,
        replyToId: message.replyToId ?? null
      });
    }
  });

export { editMessageRoute };
