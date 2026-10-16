import { ServerEvents } from '@pulse/shared';
import { eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmMessages, dmReadStates } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const markChannelAsReadRoute = protectedProcedure
  .input(z.object({ dmChannelId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    // Unread is counted as `id > lastReadMessageId` (getDmChannelsForUser),
    // so the marker must be the highest id, not the newest createdAt.
    const [newest] = await db
      .select({ id: max(dmMessages.id) })
      .from(dmMessages)
      .where(eq(dmMessages.dmChannelId, input.dmChannelId));

    const newestId = newest?.id;
    if (newestId == null) return { success: true };

    const now = Date.now();
    await db
      .insert(dmReadStates)
      .values({
        dmChannelId: input.dmChannelId,
        userId: ctx.userId,
        lastReadMessageId: newestId,
        lastReadAt: now
      })
      .onConflictDoUpdate({
        target: [dmReadStates.userId, dmReadStates.dmChannelId],
        set: {
          lastReadMessageId: newestId,
          lastReadAt: now
        }
      });

    // Self-scoped: the reader's other devices drop the badge without a
    // channel refetch (channels/mark-as-read publishes the same way).
    ctx.pubsub.publishFor(ctx.userId, ServerEvents.DM_READ_STATE_UPDATE, {
      dmChannelId: input.dmChannelId,
      lastReadMessageId: newestId
    });

    return { success: true };
  });

export { markChannelAsReadRoute };
