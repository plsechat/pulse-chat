import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmChannels } from '../../db/schema';
import { relayFederatedDmChannelStateUpdate } from '../../utils/federation-dm-state-dispatch';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const enableEncryptionRoute = protectedProcedure
  .input(z.object({ dmChannelId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    const [channel] = await db
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, input.dmChannelId))
      .limit(1);

    if (!channel) {
      return ctx.throwValidationError('dmChannelId', 'DM channel not found');
    }

    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    if (!memberIds.includes(ctx.userId)) {
      ctx.throwValidationError('dmChannelId', 'Not a member of this channel');
    }

    // Already encrypted — no-op
    if (channel.e2ee) {
      return { e2ee: true };
    }

    await db
      .update(dmChannels)
      .set({ e2ee: true, updatedAt: Date.now() })
      .where(eq(dmChannels.id, input.dmChannelId));

    // Notify all members (triggers fetchDmChannels on client)
    for (const userId of memberIds) {
      pubsub.publishFor(userId, ServerEvents.DM_CHANNEL_UPDATE, {
        dmChannelId: input.dmChannelId,
        name: channel.name,
        iconFileId: channel.iconFileId
      });
    }

    // Phase E / E2 — propagate the flag flip to peer instances so
    // federated members see the lock badge in real-time. Without
    // this, the only way the peer learns is the auto-upgrade path
    // in send-message.ts, which fires on the next encrypted message
    // — there's a confusing window in which one side is encrypted
    // and the other still allows plaintext sends.
    relayFederatedDmChannelStateUpdate(input.dmChannelId, ctx.userId, {
      e2ee: true
    });

    return { e2ee: true };
  });

export { enableEncryptionRoute };
