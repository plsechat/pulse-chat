import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Notify the rest of the DM channel that this user is declining the
 * incoming call. Pure notification — we don't track per-call decline
 * state on the server; the publish to all members lets the caller
 * know to back off (and, in 1:1 DMs, auto-leave since no one else
 * can pick up).
 *
 * Membership is gated so a non-member can't spam decline events
 * into someone else's call.
 */
const declineCallRoute = protectedProcedure
  .input(z.object({ dmChannelId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);
    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    for (const userId of memberIds) {
      pubsub.publishFor(userId, ServerEvents.DM_CALL_DECLINED, {
        dmChannelId: input.dmChannelId,
        userId: ctx.userId
      });
    }
  });

export { declineCallRoute };
