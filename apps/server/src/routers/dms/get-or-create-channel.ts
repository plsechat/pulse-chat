import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { getOrCreatePairChannel } from '../../db/mutations/dms';
import { isBlockBetween } from '../../db/queries/blocks';
import { getDmChannelsForUser } from '../../db/queries/dms';
import { areFriends } from '../../db/queries/friends';
import { sharesServerWithFederationAware } from '../../utils/federation-shares-server';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { attachMemberStatus } from './attach-member-status';

const getOrCreateChannelRoute = protectedProcedure
  .input(z.object({ userId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot create a DM with yourself'
    });

    // Don't surface the block direction to the caller — a deliberately
    // generic 404-style message keeps the blocker's identity private to
    // them. This still prevents DM creation from either side.
    const blocked = await isBlockBetween(ctx.userId, input.userId);
    invariant(!blocked, {
      code: 'NOT_FOUND',
      message: 'Cannot start a DM with this user.'
    });

    // Require shared server or existing friendship to create a DM.
    // Federation-aware: shadow targets are checked via a signed
    // co-membership attestation from their home instance.
    const friends = await areFriends(ctx.userId, input.userId);
    if (!friends) {
      const shares = await sharesServerWithFederationAware(
        ctx.userId,
        input.userId
      );
      invariant(shares, {
        code: 'FORBIDDEN',
        message: 'You must share a server or be friends to start a DM'
      });
    }

    // Upsert on the pair key — a double-click, or a relay from the other
    // user's instance arriving at the same moment, lands on the same row.
    const { id: channelId, created } = await getOrCreatePairChannel(
      ctx.userId,
      input.userId
    );

    if (created) {
      // Notify the other user so their DM list updates
      ctx.pubsub.publishFor(input.userId, ServerEvents.DM_CHANNEL_UPDATE, {
        dmChannelId: channelId,
        name: null,
        iconFileId: null
      });
    }

    const channels = attachMemberStatus(
      await getDmChannelsForUser(ctx.userId),
      ctx
    );
    return channels.find((c) => c.id === channelId)!;
  });

export { getOrCreateChannelRoute };
