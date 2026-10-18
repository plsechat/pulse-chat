import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getJoinedFriendRequest } from '../../db/queries/friends';
import { friendRequests } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const rejectRequestRoute = protectedProcedure
  .input(z.object({ requestId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    const joined = await getJoinedFriendRequest(input.requestId);

    invariant(joined, {
      code: 'NOT_FOUND',
      message: 'Friend request not found'
    });

    invariant(joined.receiverId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'You can only reject requests sent to you'
    });

    invariant(joined.status === 'pending', {
      code: 'BAD_REQUEST',
      message: 'This request is no longer pending'
    });

    await db
      .update(friendRequests)
      .set({ status: 'rejected', updatedAt: Date.now() })
      .where(eq(friendRequests.id, input.requestId));

    const rejectedPayload = { ...joined, status: 'rejected' as const };
    pubsub.publishFor(
      joined.senderId,
      ServerEvents.FRIEND_REQUEST_REJECTED,
      rejectedPayload
    );
    pubsub.publishFor(
      ctx.userId,
      ServerEvents.FRIEND_REQUEST_REJECTED,
      rejectedPayload
    );
  });

export { rejectRequestRoute };
