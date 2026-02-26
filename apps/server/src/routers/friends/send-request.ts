import { ServerEvents } from '@pulse/shared';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { areFriends, getJoinedFriendRequest } from '../../db/queries/friends';
import { sharesServerWith } from '../../db/queries/servers';
import { getUserById } from '../../db/queries/users';
import { federationInstances, friendRequests } from '../../db/schema';
import { relayToInstance } from '../../utils/federation';
import { invariant } from '../../utils/invariant';
import { logger } from '../../logger';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const sendRequestRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot send a friend request to yourself'
    });

    const alreadyFriends = await areFriends(ctx.userId, input.userId);

    invariant(!alreadyFriends, {
      code: 'BAD_REQUEST',
      message: 'You are already friends with this user'
    });

    // Require shared server to send a friend request
    const shares = await sharesServerWith(ctx.userId, input.userId);
    invariant(shares, {
      code: 'FORBIDDEN',
      message: 'You must share a server to send a friend request'
    });

    // Check for existing pending request in either direction
    const [existing] = await db
      .select()
      .from(friendRequests)
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
      )
      .limit(1);

    invariant(!existing, {
      code: 'BAD_REQUEST',
      message: 'A pending friend request already exists'
    });

    const [request] = await db
      .insert(friendRequests)
      .values({
        senderId: ctx.userId,
        receiverId: input.userId,
        status: 'pending',
        createdAt: Date.now()
      })
      .returning();

    const joined = await getJoinedFriendRequest(request!.id);

    if (joined) {
      pubsub.publishFor(
        input.userId,
        ServerEvents.FRIEND_REQUEST_RECEIVED,
        joined
      );
      pubsub.publishFor(
        ctx.userId,
        ServerEvents.FRIEND_REQUEST_RECEIVED,
        joined
      );
    }

    // Relay to remote instance if receiver is federated
    const receiver = await getUserById(input.userId);
    if (receiver?.isFederated && receiver.federatedInstanceId) {
      const [instance] = await db
        .select({ domain: federationInstances.domain })
        .from(federationInstances)
        .where(eq(federationInstances.id, receiver.federatedInstanceId))
        .limit(1);

      if (instance) {
        const sender = await getUserById(ctx.userId);
        if (sender) {
          if (!sender.publicId || !receiver.federatedPublicId) {
            logger.error(
              '[sendRequest] cannot relay: missing publicId (sender=%s, receiver=%s)',
              sender.publicId,
              receiver.federatedPublicId
            );
          } else {
            relayToInstance(instance.domain, '/federation/friend-request', {
              fromUsername: sender.name,
              fromPublicId: sender.publicId,
              fromAvatarFile: sender.avatar?.name ?? null,
              toUsername: receiver.name,
              toPublicId: receiver.federatedPublicId,
              fromUserId: ctx.userId
            }).catch((err) =>
              logger.error('[sendRequest] federation relay failed: %o', err)
            );
          }
        }
      }
    }

    return request!.id;
  });

export { sendRequestRoute };
