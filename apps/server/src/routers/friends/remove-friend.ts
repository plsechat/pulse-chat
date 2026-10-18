import { ServerEvents } from '@pulse/shared';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { areFriends } from '../../db/queries/friends';
import { getUserById } from '../../db/queries/users';
import { federationInstances, friendships } from '../../db/schema';
import { enqueueRelay } from '../../utils/federation-outbox';
import { invariant } from '../../utils/invariant';
import { logger } from '../../logger';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const removeFriendRoute = protectedProcedure
  .input(z.object({ userId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    const friends = await areFriends(ctx.userId, input.userId);

    invariant(friends, {
      code: 'BAD_REQUEST',
      message: 'You are not friends with this user'
    });

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

    const payload = { userId: ctx.userId, friendId: input.userId };

    pubsub.publishFor(ctx.userId, ServerEvents.FRIEND_REMOVED, payload);
    pubsub.publishFor(input.userId, ServerEvents.FRIEND_REMOVED, payload);

    // Relay to remote instance if removed friend is federated
    const removedFriend = await getUserById(input.userId);
    if (removedFriend?.isFederated && removedFriend.federatedInstanceId) {
      const [instance] = await db
        .select({ domain: federationInstances.domain })
        .from(federationInstances)
        .where(eq(federationInstances.id, removedFriend.federatedInstanceId))
        .limit(1);

      if (instance) {
        const remover = await getUserById(ctx.userId);
        if (remover) {
          if (!remover.publicId || !removedFriend.federatedPublicId) {
            logger.error(
              '[removeFriend] cannot relay: missing publicId (remover=%s, friend=%s)',
              remover.publicId,
              removedFriend.federatedPublicId
            );
          } else {
            enqueueRelay(instance.domain, '/federation/friend-remove', {
              fromPublicId: remover.publicId,
              toPublicId: removedFriend.federatedPublicId
            }).catch((err) =>
              logger.error('[removeFriend] federation relay failed: %o', err)
            );
          }
        }
      }
    }
  });

export { removeFriendRoute };
