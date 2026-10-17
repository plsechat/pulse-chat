import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { config } from '../../config';
import { db } from '../../db';
import { getFollowJoined } from '../../db/queries/channel-follows';
import { channelFollows, servers } from '../../db/schema';
import {
  ANNOUNCEMENT_FOLLOW_RELAY_PATH,
  publishFollowsUpdate
} from '../../utils/announcement-follow';
import { enqueueRelay } from '../../utils/federation-outbox';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

/**
 * Remove a follow. Either local side's channel settings may do it: the
 * follower (the target) stops receiving, the source drops a follower.
 * Copies already made stay — unfollowing removes the relation only.
 * The remote side, if any, is told so its own row goes too.
 */
const unfollowRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(z.object({ followId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    const row = await getFollowJoined(input.followId);

    const ownsTarget = row?.targetChannel?.serverId === ctx.activeServerId;
    const ownsSource = row?.sourceChannel?.serverId === ctx.activeServerId;
    invariant(row && (ownsTarget || ownsSource), {
      code: 'NOT_FOUND',
      message: 'Follow not found'
    });

    await db.delete(channelFollows).where(eq(channelFollows.id, row.follow.id));

    if (row.targetChannel) void publishFollowsUpdate(row.targetChannel.id);
    if (row.sourceChannel) void publishFollowsUpdate(row.sourceChannel.id);

    if (!config.federation.enabled) return;

    const [server] = await db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, ctx.activeServerId))
      .limit(1);

    // We were the follower of a remote source: the source's instance
    // holds the mirror row that relays to us.
    if (row.sourceInstance && row.follow.sourceChannelPublicId && row.targetChannel) {
      void enqueueRelay(row.sourceInstance.domain, ANNOUNCEMENT_FOLLOW_RELAY_PATH, {
        action: 'unfollow',
        serverPublicId: '',
        channelPublicId: row.follow.sourceChannelPublicId,
        targetChannelPublicId: row.targetChannel.publicId,
        targetChannelName: row.targetChannel.name,
        targetServerName: server?.name ?? ''
      }, {
        relayId: `unfollow:${row.follow.sourceChannelPublicId}:${row.targetChannel.id}`
      });
    }

    // We were the source and dropped a remote follower: its instance
    // holds the row that lists the follow in its settings.
    if (row.targetInstance && row.follow.targetChannelPublicId && row.sourceChannel) {
      void enqueueRelay(row.targetInstance.domain, ANNOUNCEMENT_FOLLOW_RELAY_PATH, {
        action: 'removed',
        channelPublicId: row.sourceChannel.publicId,
        targetChannelPublicId: row.follow.targetChannelPublicId
      }, {
        relayId: `removed:${row.sourceChannel.id}:${row.follow.targetChannelPublicId}`
      });
    }
  });

export { unfollowRoute };
