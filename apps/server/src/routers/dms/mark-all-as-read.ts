import { desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import { dmChannelMembers, dmMessages, dmReadStates } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const markAllAsReadRoute = protectedProcedure.mutation(async ({ ctx }) => {
  const memberChannels = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.userId, ctx.userId));

  for (const { dmChannelId } of memberChannels) {
    const [newestMessage] = await db
      .select({ id: dmMessages.id })
      .from(dmMessages)
      .where(eq(dmMessages.dmChannelId, dmChannelId))
      .orderBy(desc(dmMessages.createdAt))
      .limit(1);

    if (!newestMessage) continue;

    await db
      .insert(dmReadStates)
      .values({
        dmChannelId,
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
  }

  return { success: true };
});

export { markAllAsReadRoute };
