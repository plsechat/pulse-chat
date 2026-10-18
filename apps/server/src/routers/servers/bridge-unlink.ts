import { Permission } from '@pulse/shared';
import type { TBridgeServerLink } from '../../types';
import {
  deleteBridgeServerLink,
  listBridgeLinksForServer
} from '../../db/queries/bridge-links';
import { serverProcedure } from '../../utils/procedures';
import { BRIDGE_PLUGIN_ID, callBridgePlugin, isBridgePluginLoaded } from '../channels/bridge-_shared';
import { requireServerLink } from './bridge-_shared';

/**
 * Tear a server link down: every pair it produced (live and excluded)
 * goes with it by cascade, the plugin forgets its copies and deletes the
 * webhooks on the other side (paced, in the background — the row deletes
 * are what matter and they are done before this returns). Channels that
 * were created on either side stay; nothing is deleted on either side.
 * Hand-made links (no serverLinkId) are untouched.
 */
const unlinkServerBridge = async (link: TBridgeServerLink): Promise<{ removed: number }> => {
  const rows = (await listBridgeLinksForServer(BRIDGE_PLUGIN_ID, link.serverId)).filter(
    (row) => row.serverLinkId === link.id
  );
  const live = rows.filter((row) => row.webhookId !== null);

  await deleteBridgeServerLink(link.id);

  if (isBridgePluginLoaded()) {
    await callBridgePlugin('links/remove-many', {
      channelIds: live.map((row) => row.channelId)
    }).catch(() => undefined);
    await callBridgePlugin('server-links/remove', { serverId: link.serverId }).catch(() => undefined);
  }

  return { removed: live.length };
};

const bridgeUnlinkRoute = serverProcedure(Permission.MANAGE_SETTINGS).mutation(async ({ ctx }) => {
  const link = await requireServerLink(ctx.activeServerId);

  return unlinkServerBridge(link);
});

export { bridgeUnlinkRoute, unlinkServerBridge };
