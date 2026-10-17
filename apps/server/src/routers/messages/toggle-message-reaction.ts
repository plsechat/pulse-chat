import { ChannelPermission, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getEmojiFileIdByEmojiName } from '../../db/queries/emojis';
import {
  getMessageInActiveServer,
  getReaction
} from '../../db/queries/messages';
import { messageReactions } from '../../db/schema';
import { eventBus } from '../../plugins/event-bus';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/** A unicode emoji or a `:custom_name:` token — never free text. */
const MAX_EMOJI_LENGTH = 64;

const toggleMessageReactionRoute = serverProcedure(
  Permission.REACT_TO_MESSAGES
)
  .input(
    z.object({
      messageId: z.number().int().positive(),
      emoji: z.string().min(1).max(MAX_EMOJI_LENGTH)
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

    // Server scope alone still lets a member react inside a private
    // channel they cannot view (and learn the message exists).
    await ctx.needsChannelPermission(
      message.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const reaction = await getReaction(
      input.messageId,
      input.emoji,
      ctx.user.id
    );

    if (!reaction) {
      const emojiFileId = await getEmojiFileIdByEmojiName(input.emoji);

      await db.insert(messageReactions).values({
        messageId: input.messageId,
        emoji: input.emoji,
        userId: ctx.user.id,
        fileId: emojiFileId,
        createdAt: Date.now()
      });
    } else {
      await db
        .delete(messageReactions)
        .where(
          and(
            eq(messageReactions.messageId, input.messageId),
            eq(messageReactions.emoji, input.emoji),
            eq(messageReactions.userId, ctx.user.id)
          )
        );
    }

    publishMessage(input.messageId, message.channelId, 'update');

    eventBus.emit('message:reaction', {
      messageId: input.messageId,
      channelId: message.channelId,
      userId: ctx.user.id,
      emoji: input.emoji,
      added: !reaction
    });
  });

export { toggleMessageReactionRoute };
