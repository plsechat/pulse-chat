import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { addBlock } from '../../db/queries/blocks';
import { friendRequests, friendships } from '../../db/schema';
import { and, eq, or } from 'drizzle-orm';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

/**
 * Block a user. The act of blocking implicitly removes any existing
 * friendship and rejects any pending friend request in either
 * direction — keeping a friendship between blocker and blocked would
 * surface contradictory UI ("they're your friend, but you can't message
 * them"). Symmetric invisibility is enforced lazily on the read paths
 * (DMs, friend-request send, etc.) by checking either direction of
 * the user_blocks edges.
 */
const blockRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot block yourself'
    });

    await addBlock(ctx.userId, input.userId);

    // Tear down the friendship in both stored directions if either
    // exists. The schema doesn't enforce a canonical (low,high)
    // ordering, so check both.
    await db
      .delete(friendships)
      .where(
        or(
          and(
            eq(friendships.userId, ctx.userId),
            eq(friendships.friendId, input.userId)
          ),
          and(
            eq(friendships.userId, input.userId),
            eq(friendships.friendId, ctx.userId)
          )
        )
      );

    // Drop any pending request between the two users so the blocked
    // party doesn't see a stale "pending" state on their side.
    await db
      .delete(friendRequests)
      .where(
        and(
          or(
            and(
              eq(friendRequests.senderId, ctx.userId),
              eq(friendRequests.receiverId, input.userId)
            ),
            and(
              eq(friendRequests.senderId, input.userId),
              eq(friendRequests.receiverId, ctx.userId)
            )
          ),
          eq(friendRequests.status, 'pending')
        )
      );

    pubsub.publishFor(ctx.userId, ServerEvents.USER_BLOCK_CHANGED, {
      blockedUserId: input.userId,
      blocked: true
    });
    // Also tell the blocked user so their client drops any cached
    // friendship state — without this the friend stays in their list
    // until they refresh, even though the friendship row is gone.
    pubsub.publishFor(input.userId, ServerEvents.FRIEND_REMOVED, {
      userId: input.userId,
      friendId: ctx.userId
    });
  });

export { blockRoute };
