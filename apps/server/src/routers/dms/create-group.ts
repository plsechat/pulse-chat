import { ServerEvents } from '@pulse/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelsForUser } from '../../db/queries/dms';
import { dmChannelMembers, dmChannels, friendships } from '../../db/schema';
import {
  announceFederatedGroupCreate,
  assignFederationGroupIdIfNeeded
} from '../../utils/federation-dm-group-dispatch';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';
import { attachMemberStatus } from './attach-member-status';

const createGroupRoute = protectedProcedure
  .input(
    z.object({
      userIds: z.array(z.number().int().positive()).min(1).max(9),
      name: z.string().trim().max(100).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Duplicates would collide on the members primary key and surface
    // as a raw DB error — collapse them first.
    const userIds = [...new Set(input.userIds)];

    invariant(!userIds.includes(ctx.userId), {
      code: 'BAD_REQUEST',
      message: 'Cannot add yourself'
    });

    // Friendship gate — one batched lookup (same shape as addMember)
    // instead of a query per id.
    const friendRows = await db
      .select({
        userId: friendships.userId,
        friendId: friendships.friendId
      })
      .from(friendships)
      .where(
        or(
          and(
            eq(friendships.userId, ctx.userId),
            inArray(friendships.friendId, userIds)
          ),
          and(
            eq(friendships.friendId, ctx.userId),
            inArray(friendships.userId, userIds)
          )
        )
      );
    const friendIds = new Set(
      friendRows.map((r) => (r.userId === ctx.userId ? r.friendId : r.userId))
    );
    for (const id of userIds) {
      invariant(friendIds.has(id), {
        code: 'BAD_REQUEST',
        message: 'You can only add friends to a group DM'
      });
    }

    const now = Date.now();

    const [channel] = await db
      .insert(dmChannels)
      .values({
        name: input.name || null,
        ownerId: ctx.userId,
        isGroup: true,
        createdAt: now
      })
      .returning();

    // Add all members (including the creator)
    const allMemberIds = [ctx.userId, ...userIds];

    await db.insert(dmChannelMembers).values(
      allMemberIds.map((userId) => ({
        dmChannelId: channel!.id,
        userId,
        createdAt: now
      }))
    );

    // Notify all members
    for (const userId of allMemberIds) {
      pubsub.publishFor(userId, ServerEvents.DM_CHANNEL_UPDATE, {
        dmChannelId: channel!.id,
        name: channel!.name,
        iconFileId: null
      });
    }

    // Phase D / D2 — if any member is federated, assign a
    // federationGroupId and announce the group to every involved
    // peer instance so each builds a local mirror channel keyed by
    // that ID. Best-effort; a failed peer announcement leaves the
    // local group functional and the peer can still receive
    // messages once they catch up via re-announce on next message.
    const federationGroupId = await assignFederationGroupIdIfNeeded(channel!.id);
    if (federationGroupId) {
      void announceFederatedGroupCreate(channel!.id, ctx.userId);
    }

    const channels = attachMemberStatus(
      await getDmChannelsForUser(ctx.userId),
      ctx
    );
    return channels.find((c) => c.id === channel!.id)!;
  });

export { createGroupRoute };
