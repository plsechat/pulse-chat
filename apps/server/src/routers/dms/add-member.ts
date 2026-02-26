import { ServerEvents } from '@pulse/shared';
import { and, eq, or } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannelMembers, dmChannels, friendships } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const addMemberRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number(),
      userId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Verify the channel exists and is a group DM
    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);

    if (!channel || !channel.isGroup) {
      return ctx.throwValidationError('dmChannelId', 'Group DM not found');
    }

    // Check member limit (max 10)
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    // Only the owner can add members, and they must still be a member
    if (channel.ownerId !== ctx.userId || !memberIds.includes(ctx.userId)) {
      return ctx.throwValidationError('dmChannelId', 'Only the group owner can add members');
    }

    if (memberIds.length >= 10) {
      ctx.throwValidationError('userId', 'Group DM is full (max 10 members)');
    }

    if (memberIds.includes(input.userId)) {
      ctx.throwValidationError('userId', 'User is already a member');
    }

    // Verify the user being added is a friend
    const [friendship] = await db
      .select()
      .from(friendships)
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
      )
      .limit(1);

    if (!friendship) {
      ctx.throwValidationError('userId', 'You can only add friends to a group DM');
    }

    await db.insert(dmChannelMembers).values({
      dmChannelId: input.dmChannelId,
      userId: input.userId,
      createdAt: Date.now()
    });

    // Notify all members (including the newly added one)
    const allMembers = [...memberIds, input.userId];

    for (const userId of allMembers) {
      pubsub.publishFor(userId, ServerEvents.DM_MEMBER_ADD, {
        dmChannelId: input.dmChannelId,
        userId: input.userId
      });
    }
  });

export { addMemberRoute };
