import { Permission } from '@pulse/shared';
import { z } from 'zod';
import { deleteBridgeLink, getBridgeLinkByChannelId } from '../../db/queries/bridge-links';
import { serverProcedure } from '../../utils/procedures';
import {
  BRIDGE_PLUGIN_ID,
  callBridgePlugin,
  isBridgePluginLoaded,
  loadScopedChannel
} from './bridge-_shared';

/**
 * Remove a channel's bridge. The row goes first (durable); the plugin
 * is told afterwards so it drops its copy and deletes the webhook. A
 * plugin that is not running cannot be told — the row is gone either
 * way, and the plugin reconciles through `bridgeStatus` the next time
 * the tab opens (a link it still holds but the server no longer has is
 * removed there).
 */
const bridgeUnlinkRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(z.object({ channelId: z.number().int().positive() }))
  .mutation(async ({ ctx, input }) => {
    const channel = await loadScopedChannel(input.channelId, ctx.activeServerId);
    const link = await getBridgeLinkByChannelId(BRIDGE_PLUGIN_ID, channel.id);

    if (!link) return { removed: false };

    await deleteBridgeLink(link.id);

    if (isBridgePluginLoaded()) {
      await callBridgePlugin('links/remove', { channelId: channel.id }).catch(() => undefined);
    }

    return { removed: true };
  });

export { bridgeUnlinkRoute };
