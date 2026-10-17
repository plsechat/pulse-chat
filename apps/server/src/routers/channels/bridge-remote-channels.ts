import { Permission } from '@pulse/shared';
import { z } from 'zod';
import type { TBridgeRemoteChannel, TBridgeRemoteGuild } from '../../types';
import { serverProcedure } from '../../utils/procedures';
import { callBridgePlugin, remoteIdSchema } from './bridge-_shared';

type TRemoteListing = { guilds: TBridgeRemoteGuild[]; channels: TBridgeRemoteChannel[] };

/**
 * The picker's lists: the servers the bot sits in, and — once one is
 * chosen — its text channels. Proxied through the plugin, which holds
 * the bot token; the server never sees it.
 */
const bridgeRemoteChannelsRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(z.object({ guildId: remoteIdSchema.optional() }))
  .query(async ({ input }): Promise<TRemoteListing> => {
    const listing = await callBridgePlugin<TRemoteListing>('channels', {
      guildId: input.guildId
    });

    return {
      guilds: Array.isArray(listing?.guilds) ? listing.guilds.slice(0, 200) : [],
      channels: Array.isArray(listing?.channels) ? listing.channels.slice(0, 500) : []
    };
  });

export { bridgeRemoteChannelsRoute };
