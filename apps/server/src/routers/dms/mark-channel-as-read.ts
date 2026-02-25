import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmMessages, dmReadStates } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const markChannelAsReadRoute = protectedProcedure
  .input(z.object({ dmChannelId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    const [newestMessage] = await db
      .select({ id: dmMessages.id })
      .from(dmMessages)
      .where(eq(dmMessages.dmChannelId, input.dmChannelId))
      .orderBy(desc(dmMessages.createdAt))
      .limit(1);

    if (!newestMessage) return { success: true };

    await db
      .insert(dmReadStates)
      .values({
        dmChannelId: input.dmChannelId,
        userId: ctx.userId,
        lastReadMessageId: newestMessage.id,
        lastReadAt: Date.now()
      })
      .onConflictDoUpdate({
        target: [dmReadStates.userId, dmReadStates.dmChannelId],
        set: {
          lastReadMessageId: newestMessage.id,
          lastReadAt: Date.now()
        }
      });

    return { success: true };
  });

export { markChannelAsReadRoute };
