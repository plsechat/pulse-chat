import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getJoinedFriendRequest } from '../../db/queries/friends';
import { getUserById } from '../../db/queries/users';
import { federationInstances, friendRequests, friendships } from '../../db/schema';
import { relayToInstance } from '../../utils/federation';
import { invariant } from '../../utils/invariant';
import { logger } from '../../logger';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const acceptRequestRoute = protectedProcedure
  .input(z.object({ requestId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    const [request] = await db
      .select()
      .from(friendRequests)
      .where(eq(friendRequests.id, input.requestId))
      .limit(1);

    invariant(request, {
      code: 'NOT_FOUND',
      message: `Friend request ${input.requestId} not found`
    });

    invariant(request.receiverId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'You can only accept requests sent to you'
    });

    invariant(request.status === 'pending', {
      code: 'BAD_REQUEST',
      message: 'This request is no longer pending'
    });

    await db
      .update(friendRequests)
      .set({ status: 'accepted', updatedAt: Date.now() })
      .where(eq(friendRequests.id, input.requestId));

    // Create friendship in both directions for easy querying
    await db.insert(friendships).values({
      userId: request.senderId,
      friendId: request.receiverId,
      createdAt: Date.now()
    });

    const joined = await getJoinedFriendRequest(input.requestId);

    if (joined) {
      pubsub.publishFor(
        request.senderId,
        ServerEvents.FRIEND_REQUEST_ACCEPTED,
        joined
      );
      pubsub.publishFor(
        request.receiverId,
        ServerEvents.FRIEND_REQUEST_ACCEPTED,
        joined
      );
    }

    // Relay to remote instance if the original sender is federated
    const sender = await getUserById(request.senderId);
    if (sender?.isFederated && sender.federatedInstanceId) {
      const [instance] = await db
        .select({ domain: federationInstances.domain })
        .from(federationInstances)
        .where(eq(federationInstances.id, sender.federatedInstanceId))
        .limit(1);

      if (instance) {
        const accepter = await getUserById(ctx.userId);
        if (accepter) {
          if (!accepter.publicId || !sender.federatedPublicId) {
            logger.error(
              '[acceptRequest] cannot relay: missing publicId (accepter=%s, sender=%s)',
              accepter.publicId,
              sender.federatedPublicId
            );
          } else {
            relayToInstance(instance.domain, '/federation/friend-accept', {
              fromUsername: accepter.name,
              fromPublicId: accepter.publicId,
              fromAvatarFile: accepter.avatar?.name ?? null,
              toUsername: sender.name,
              toPublicId: sender.federatedPublicId,
              fromUserId: ctx.userId
            }).catch((err) =>
              logger.error('[acceptRequest] federation relay failed: %o', err)
            );
          }
        }
      }
    }
  });

export { acceptRequestRoute };
