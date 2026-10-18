import { Permission } from '@pulse/shared';
import { z } from 'zod';
import {
  deleteBridgeLink,
  getBridgeLinkByChannelId,
  getBridgeServerLink,
  insertExcludedBridgeLink,
  markBridgeLinkExcluded,
  toBridgeLinkView
} from '../../db/queries/bridge-links';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { syncServerBridge } from '../servers/bridge-sync';
import {
  BRIDGE_PLUGIN_ID,
  callBridgePlugin,
  isBridgePluginLoaded,
  loadScopedChannel
} from './bridge-_shared';

/**
 * Opt a channel out of (or back into) the server link.
 *
 * Excluding keeps a row so the sync does not pair the channel again: a
 * live pair loses its webhook (the plugin deletes it) and remembers the
 * remote channel; a channel that never paired gets a placeholder row so
 * mirror mode does not create its twin over there. Including again
 * deletes that row and runs a sync, which pairs the channel by name as
 * if it were new. A hand-made link (no serverLinkId) is not the server
 * link's to exclude: its own Unlink is the way out.
 */
const bridgeExcludeRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(z.object({ channelId: z.number().int().positive(), excluded: z.boolean() }))
  .mutation(async ({ ctx, input }) => {
    const channel = await loadScopedChannel(input.channelId, ctx.activeServerId);
    const serverLink = await getBridgeServerLink(BRIDGE_PLUGIN_ID, channel.serverId);

    invariant(serverLink, {
      code: 'PRECONDITION_FAILED',
      message: 'This server is not linked to a remote server'
    });

    const existing = await getBridgeLinkByChannelId(BRIDGE_PLUGIN_ID, channel.id);

    invariant(!existing || existing.serverLinkId !== null, {
      code: 'BAD_REQUEST',
      message: 'This channel is linked on its own; unlink it from its Bridge tab instead.'
    });

    if (input.excluded) {
      if (existing?.excluded) return toBridgeLinkView(existing);

      if (existing) {
        if (isBridgePluginLoaded()) {
          await callBridgePlugin('links/remove', { channelId: channel.id }).catch(() => undefined);
        }

        const row = await markBridgeLinkExcluded(existing.id);
        invariant(row, { code: 'NOT_FOUND', message: 'Bridge link not found' });
        return toBridgeLinkView(row);
      }

      const row = await insertExcludedBridgeLink({
        pluginId: BRIDGE_PLUGIN_ID,
        channelId: channel.id,
        remoteGuildId: serverLink.remoteGuildId,
        serverLinkId: serverLink.id,
        createdBy: ctx.user.id
      });

      return toBridgeLinkView(row);
    }

    if (existing?.excluded) {
      await deleteBridgeLink(existing.id);
    }

    if (isBridgePluginLoaded()) {
      void syncServerBridge(channel.serverId, 'manual');
    }

    return null;
  });

export { bridgeExcludeRoute };
