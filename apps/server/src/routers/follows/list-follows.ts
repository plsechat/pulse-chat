import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import { listFollowsForChannel } from '../../db/queries/channel-follows';
import { servers } from '../../db/schema';
import { channelProcedure } from '../../utils/procedures';

/**
 * The Follows tab's data: MANAGE_CHANNELS, like the rest of channel
 * settings. `address` is what a peer types to follow THIS channel
 * (`domain/serverPublicId/channelPublicId`); null unless the channel is
 * an announcement channel of a federatable server on a federating
 * instance — exactly the conditions the peer-side receiver checks.
 */
const listFollowsRoute = channelProcedure(undefined, {
  serverPermission: Permission.MANAGE_CHANNELS
}).query(async ({ ctx }) => {
  const relations = await listFollowsForChannel(ctx.channel.id);

  let address: string | null = null;
  if (config.federation.enabled && ctx.channel.announcement && !ctx.channel.private) {
    const [server] = await db
      .select({ publicId: servers.publicId, federatable: servers.federatable })
      .from(servers)
      .where(eq(servers.id, ctx.channel.serverId))
      .limit(1);
    if (server?.federatable) {
      address = `${config.federation.domain}/${server.publicId}/${ctx.channel.publicId}`;
    }
  }

  return { ...relations, address };
});

export { listFollowsRoute };
