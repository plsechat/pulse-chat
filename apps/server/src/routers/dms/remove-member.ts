import { ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannelMembers, dmChannels, users } from '../../db/schema';
import { VoiceRuntime } from '../../runtimes/voice';
import { announceFederatedGroupRemoveMember } from '../../utils/federation-dm-group-dispatch';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';
import { removeUserFromVoice } from '../../utils/voice-cleanup';

const removeMemberRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number().int().positive(),
      userId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);

    if (!channel || !channel.isGroup) {
      return ctx.throwValidationError('dmChannelId', 'Group DM not found');
    }

    // Only the owner can remove members
    if (channel.ownerId !== ctx.userId) {
      ctx.throwValidationError('dmChannelId', 'Only the group owner can remove members');
    }

    if (input.userId === ctx.userId) {
      ctx.throwValidationError('userId', 'Use leave instead');
    }

    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    if (!memberIds.includes(input.userId)) {
      ctx.throwValidationError('userId', 'User is not a member');
    }

    // Capture the removed user's federated publicId BEFORE deleting,
    // so we have it for the federation announcement below.
    const [removedUser] = await db
      .select({
        publicId: users.publicId,
        isFederated: users.isFederated,
        federatedPublicId: users.federatedPublicId
      })
      .from(users)
      .where(eq(users.id, input.userId))
      .limit(1);
    const removedPublicId = removedUser?.isFederated
      ? removedUser.federatedPublicId ?? removedUser.publicId
      : removedUser?.publicId ?? null;

    // A removed member must not keep hearing the group's call. Evicted
    // before the member row goes so the leave fan-out (which resolves
    // the audience through membership) still reaches everyone,
    // including the removed user.
    const targetRuntime = VoiceRuntime.findRuntimeByUserId(input.userId);
    if (
      targetRuntime &&
      targetRuntime.isDmVoice &&
      targetRuntime.id === input.dmChannelId
    ) {
      await removeUserFromVoice(input.userId);
    }

    await db
      .delete(dmChannelMembers)
      .where(
        and(
          eq(dmChannelMembers.dmChannelId, input.dmChannelId),
          eq(dmChannelMembers.userId, input.userId)
        )
      );

    // Notify all members (including the removed one)
    for (const userId of memberIds) {
      pubsub.publishFor(userId, ServerEvents.DM_MEMBER_REMOVE, {
        dmChannelId: input.dmChannelId,
        userId: input.userId
      });
    }

    // Phase D / D2 — federation propagation for federated groups.
    if (channel.federationGroupId && removedPublicId) {
      void announceFederatedGroupRemoveMember(
        input.dmChannelId,
        input.userId,
        removedPublicId
      );
    }
  });

export { removeMemberRoute };
