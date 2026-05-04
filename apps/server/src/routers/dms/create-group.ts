import { ServerEvents } from '@pulse/shared';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelsForUser } from '../../db/queries/dms';
import { dmChannelMembers, dmChannels, friendships } from '../../db/schema';
import {
  announceFederatedGroupCreate,
  assignFederationGroupIdIfNeeded
} from '../../utils/federation-dm-group-dispatch';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const createGroupRoute = protectedProcedure
  .input(
    z.object({
      userIds: z.array(z.number()).min(1).max(9),
      name: z.string().max(100).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Verify all userIds are friends of the current user
    for (const userId of input.userIds) {
      if (userId === ctx.userId) {
        ctx.throwValidationError('userIds', 'Cannot add yourself');
      }

      const [friendship] = await db
        .select()
        .from(friendships)
        .where(
          or(
            and(
              eq(friendships.userId, ctx.userId),
              eq(friendships.friendId, userId)
            ),
            and(
              eq(friendships.userId, userId),
              eq(friendships.friendId, ctx.userId)
            )
          )
        )
        .limit(1);

      if (!friendship) {
        ctx.throwValidationError(
          'userIds',
          'You can only add friends to a group DM'
        );
      }
    }

    const now = Date.now();

    const [channel] = await db
      .insert(dmChannels)
      .values({
        name: input.name ?? null,
        ownerId: ctx.userId,
        isGroup: true,
        createdAt: now
      })
      .returning();

    // Add all members (including the creator)
    const allMemberIds = [ctx.userId, ...input.userIds];

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

    const channels = await getDmChannelsForUser(ctx.userId);
    return channels.find((c) => c.id === channel!.id)!;
  });

export { createGroupRoute };
