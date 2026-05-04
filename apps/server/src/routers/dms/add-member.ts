import { ServerEvents } from '@pulse/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannelMembers, dmChannels, friendships } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const MAX_GROUP_MEMBERS = 10;

const addMemberRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number(),
      // Batch input + accept >=1 so the same route handles both
      // "add one to a group" and "promote a 1:1 to a group with N
      // additional people in a single click."
      userIds: z.array(z.number().int().positive()).min(1).max(9)
    })
  )
  .mutation(async ({ input, ctx }) => {
    const dedupedNewIds = [...new Set(input.userIds)];

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
      message: 'You are not a member of this DM channel'
    });

    // Group permission: only the owner adds. For 1:1s being promoted
    // to a group, anyone in the channel can initiate; the caller
    // becomes the new owner of the resulting group.
    if (channel.isGroup) {
      invariant(channel.ownerId === ctx.userId, {
        code: 'FORBIDDEN',
        message: 'Only the group owner can add members'
      });
    }

    // Already-member filter happens before the friendship check so we
    // don't reject the whole batch if one of the picks is redundant.
    const already = new Set(memberIds);
    const toAdd = dedupedNewIds.filter((id) => !already.has(id));
    invariant(toAdd.length > 0, {
      code: 'BAD_REQUEST',
      message: 'All selected users are already members'
    });

    const finalSize = memberIds.length + toAdd.length;
    invariant(finalSize <= MAX_GROUP_MEMBERS, {
      code: 'BAD_REQUEST',
      message: `Group DM is full (max ${MAX_GROUP_MEMBERS} members)`
    });

    // Friendship gate — same rule as createGroup. Batch the lookup so
    // a 9-user add doesn't run 9 sequential queries.
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
            inArray(friendships.friendId, toAdd)
          ),
          and(
            eq(friendships.friendId, ctx.userId),
            inArray(friendships.userId, toAdd)
          )
        )
      );
    const friendIds = new Set(
      friendRows.map((r) => (r.userId === ctx.userId ? r.friendId : r.userId))
    );
    for (const id of toAdd) {
      invariant(friendIds.has(id), {
        code: 'BAD_REQUEST',
        message: 'You can only add friends to a group DM'
      });
    }

    // 1:1 → group conversion. Flip the flag, set the caller as owner,
    // then bulk-insert the new members. Existing pairwise-encrypted
    // messages remain undecryptable to new joiners (the pairwise
    // sessions were keyed to the original two users); future sends
    // use sender keys via the existing ensureDmGroupSenderKey path
    // on the client. Crypto continuity is intentionally not part of
    // this v1 — Discord behaves the same way on this conversion.
    const wasPromotion = !channel.isGroup;
    if (wasPromotion) {
      await db
        .update(dmChannels)
        .set({
          isGroup: true,
          ownerId: ctx.userId,
          updatedAt: Date.now()
        })
        .where(eq(dmChannels.id, input.dmChannelId));
    }

    const now = Date.now();
    await db.insert(dmChannelMembers).values(
      toAdd.map((userId) => ({
        dmChannelId: input.dmChannelId,
        userId,
        createdAt: now
      }))
    );

    const allRecipients = [...memberIds, ...toAdd];

    // If we just promoted a 1:1, broadcast a channel-update so every
    // client re-fetches and sees `isGroup=true`. Otherwise the
    // channel header / sidebar would still treat it as a 1:1.
    if (wasPromotion) {
      for (const userId of allRecipients) {
        pubsub.publishFor(userId, ServerEvents.DM_CHANNEL_UPDATE, {
          dmChannelId: input.dmChannelId,
          name: channel.name,
          iconFileId: channel.iconFileId
        });
      }
    }

    for (const addedId of toAdd) {
      for (const recipient of allRecipients) {
        pubsub.publishFor(recipient, ServerEvents.DM_MEMBER_ADD, {
          dmChannelId: input.dmChannelId,
          userId: addedId
        });
      }
    }
  });

export { addMemberRoute };
