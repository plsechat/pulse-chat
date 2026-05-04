import { ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannelMembers, dmChannels } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Leave a DM channel — works for both groups and 1:1s. Earlier this
 * route rejected 1:1s ("Group DM not found"), so the only way out
 * of a 1:1 was Delete Conversation, which nukes history for both
 * sides. Now leaving is per-user: the leaver stops getting events,
 * the channel disappears from their list. The other side keeps the
 * conversation. If the channel ends up empty, we delete it.
 */
const leaveGroupRoute = protectedProcedure
  .input(z.object({ dmChannelId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'DM channel not found'
    });

    const memberIds = await getDmChannelMemberIds(input.dmChannelId);
    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'Not a member of this DM channel'
    });

    // Remove the user
    await db
      .delete(dmChannelMembers)
      .where(
        and(
          eq(dmChannelMembers.dmChannelId, input.dmChannelId),
          eq(dmChannelMembers.userId, ctx.userId)
        )
      );

    // If the owner is leaving, transfer ownership to the next
    // member (group only — 1:1 doesn't have an owner concept that
    // matters once a side leaves).
    if (channel.isGroup && channel.ownerId === ctx.userId) {
      const remainingMembers = memberIds.filter((id) => id !== ctx.userId);

      if (remainingMembers.length > 0) {
        await db
          .update(dmChannels)
          .set({ ownerId: remainingMembers[0], updatedAt: Date.now() })
          .where(eq(dmChannels.id, input.dmChannelId));
      }
    }

    const remainingMembers = memberIds.filter((id) => id !== ctx.userId);

    // Empty channel? Drop the row entirely. Cascades clean up
    // messages + members + sender keys via FK on delete.
    if (remainingMembers.length === 0) {
      await db.delete(dmChannels).where(eq(dmChannels.id, input.dmChannelId));
      // Tell the leaver to drop it from their cached list too —
      // their member row is gone but the client still holds the
      // channel until DM_CHANNEL_DELETE arrives.
      pubsub.publishFor(ctx.userId, ServerEvents.DM_CHANNEL_DELETE, {
        dmChannelId: input.dmChannelId
      });
      return;
    }

    // Notify remaining members so their UI updates (member list,
    // sender keys for e2ee groups, etc).
    for (const userId of remainingMembers) {
      pubsub.publishFor(userId, ServerEvents.DM_MEMBER_REMOVE, {
        dmChannelId: input.dmChannelId,
        userId: ctx.userId
      });
    }

    // Tell the leaver to drop it from their cached list. The
    // member-remove event above goes to remaining members only;
    // without this fan-out the leaver's own UI would still show
    // the channel until next refresh.
    pubsub.publishFor(ctx.userId, ServerEvents.DM_CHANNEL_DELETE, {
      dmChannelId: input.dmChannelId
    });
  });

export { leaveGroupRoute };
