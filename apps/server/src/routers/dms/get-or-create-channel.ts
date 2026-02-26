import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { findDmChannelBetween, getDmChannelsForUser } from '../../db/queries/dms';
import { areFriends } from '../../db/queries/friends';
import { sharesServerWith } from '../../db/queries/servers';
import { dmChannelMembers, dmChannels } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const getOrCreateChannelRoute = protectedProcedure
  .input(z.object({ userId: z.number() }))
  .mutation(async ({ ctx, input }) => {
    invariant(input.userId !== ctx.userId, {
      code: 'BAD_REQUEST',
      message: 'You cannot create a DM with yourself'
    });

    // Require shared server or existing friendship to create a DM
    const friends = await areFriends(ctx.userId, input.userId);
    if (!friends) {
      const shares = await sharesServerWith(ctx.userId, input.userId);
      invariant(shares, {
        code: 'FORBIDDEN',
        message: 'You must share a server or be friends to start a DM'
      });
    }

    // Check if a DM channel already exists
    const existingChannelId = await findDmChannelBetween(
      ctx.userId,
      input.userId
    );

    if (existingChannelId) {
      const channels = await getDmChannelsForUser(ctx.userId);
      return channels.find((c) => c.id === existingChannelId)!;
    }

    // Create new DM channel
    const now = Date.now();

    const [channel] = await db
      .insert(dmChannels)
      .values({ createdAt: now })
      .returning();

    await db.insert(dmChannelMembers).values([
      { dmChannelId: channel!.id, userId: ctx.userId, createdAt: now },
      { dmChannelId: channel!.id, userId: input.userId, createdAt: now }
    ]);

    // Notify the other user so their DM list updates
    ctx.pubsub.publishFor(input.userId, ServerEvents.DM_CHANNEL_UPDATE, {
      dmChannelId: channel!.id,
      name: null,
      iconFileId: null
    });

    const channels = await getDmChannelsForUser(ctx.userId);
    return channels.find((c) => c.id === channel!.id)!;
  });

export { getOrCreateChannelRoute };
