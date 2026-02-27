import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getEmojiFileIdByEmojiName } from '../../db/queries/emojis';
import { getReaction } from '../../db/queries/messages';
import { channels, messageReactions, messages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const toggleMessageReactionRoute = protectedProcedure
  .input(
    z.object({
      messageId: z.number(),
      emoji: z.string()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.REACT_TO_MESSAGES);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const [message] = await db
      .select()
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(and(eq(messages.id, input.messageId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(message, {
      code: 'NOT_FOUND',
      message: `Message ${input.messageId} not found`
    });

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

    publishMessage(input.messageId, message.messages.channelId, 'update');
  });

export { toggleMessageReactionRoute };
