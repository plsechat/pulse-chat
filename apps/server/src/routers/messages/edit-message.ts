import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { messages } from '../../db/schema';
import { parseMentionedUserIds } from '../../helpers/parse-mentions';
import { eventBus } from '../../plugins/event-bus';
import { enqueueProcessMetadata } from '../../queues/message-metadata';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const editMessageRoute = protectedProcedure
  .input(
    z.object({
      messageId: z.number(),
      content: z.string().max(4000).optional(),
      encryptedContent: z.string().max(16000).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [message] = await db
      .select({
        userId: messages.userId,
        channelId: messages.channelId,
        editable: messages.editable,
        e2ee: messages.e2ee
      })
      .from(messages)
      .where(eq(messages.id, input.messageId))
      .limit(1);

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
      invariant(input.encryptedContent, {
        code: 'BAD_REQUEST',
        message: 'E2EE messages must be edited with encryptedContent'
      });
      updateSet.encryptedContent = input.encryptedContent;
    } else {
      invariant(input.content, {
        code: 'BAD_REQUEST',
        message: 'Non-E2EE messages must be edited with content'
      });
      updateSet.content = input.content;

      // Re-parse mentions on edit
      const memberIds = await getAffectedUserIdsForChannel(message.channelId);
      const parsed = await parseMentionedUserIds(input.content, memberIds);
      updateSet.mentionedUserIds = parsed.userIds.length > 0 ? parsed.userIds : null;
      updateSet.mentionsAll = parsed.mentionsAll;
    }

    await db
      .update(messages)
      .set(updateSet)
      .where(eq(messages.id, input.messageId));

    publishMessage(input.messageId, message.channelId, 'update');

    if (!message.e2ee && input.content) {
      enqueueProcessMetadata(input.content, input.messageId);

      eventBus.emit('message:updated', {
        messageId: input.messageId,
        channelId: message.channelId,
        userId: message.userId,
        content: input.content
      });
    }
  });

export { editMessageRoute };
