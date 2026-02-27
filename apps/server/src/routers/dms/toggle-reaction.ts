import { ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getEmojiFileIdByEmojiName } from '../../db/queries/emojis';
import { getDmChannelMemberIds, getDmMessage, getDmReaction } from '../../db/queries/dms';
import { dmMessageReactions, dmMessages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const toggleDmReactionRoute = protectedProcedure
  .input(
    z.object({
      dmMessageId: z.number(),
      emoji: z.string()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [message] = await db
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.id, input.dmMessageId))
      .limit(1);

    invariant(message, {
      code: 'NOT_FOUND',
      message: `DM message ${input.dmMessageId} not found`
    });

    const memberIds = await getDmChannelMemberIds(message.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    const reaction = await getDmReaction(
      input.dmMessageId,
      input.emoji,
      ctx.userId
    );

    if (!reaction) {
      const emojiFileId = await getEmojiFileIdByEmojiName(input.emoji);

      await db.insert(dmMessageReactions).values({
        dmMessageId: input.dmMessageId,
        emoji: input.emoji,
        userId: ctx.userId,
        fileId: emojiFileId,
        createdAt: Date.now()
      });
    } else {
      await db
        .delete(dmMessageReactions)
        .where(
          and(
            eq(dmMessageReactions.dmMessageId, input.dmMessageId),
            eq(dmMessageReactions.emoji, input.emoji),
            eq(dmMessageReactions.userId, ctx.userId)
          )
        );
    }

    const updated = await getDmMessage(input.dmMessageId);

    if (updated) {
      for (const memberId of memberIds) {
        ctx.pubsub.publishFor(
          memberId,
          ServerEvents.DM_MESSAGE_UPDATE,
          updated
        );
      }
    }
  });

export { toggleDmReactionRoute };
