import { Permission } from '@pulse/shared';
import type { TBridgeServerStatus } from '../../types';
import {
  getBridgeServerLink,
  listBridgeLinksForServer,
  readBridgeWebhookToken,
  toBridgeServerLinkView
} from '../../db/queries/bridge-links';
import { serverProcedure } from '../../utils/procedures';
import { BRIDGE_PLUGIN_ID, callBridgePlugin, isBridgePluginLoaded } from '../channels/bridge-_shared';
import { pluginStatus, pushServerLinkToPlugin } from './bridge-_shared';
import { getServerBridgeSyncState, noteSyncRequest } from './bridge-sync';

/**
 * Server Settings → Bridge: the link on record, the counts, the last
 * sync and the plugin's live view. As the channel status does, this is
 * where the two copies meet and are reconciled: a live pair the plugin
 * lost is pushed again with its decrypted token, a pair the plugin
 * still holds but the server dropped is removed from the plugin, and
 * the plugin's copy of the server link itself is refreshed. When the
 * plugin reports the remote side changed since we last looked, a sync
 * starts (in the background) so the owner opening this page sees the
 * catch-up begin.
 */
const bridgeStatusRoute = serverProcedure(Permission.MANAGE_SETTINGS).query(
  async ({ ctx }): Promise<TBridgeServerStatus> => {
    const serverId = ctx.activeServerId;
    const row = await getBridgeServerLink(BRIDGE_PLUGIN_ID, serverId);
    const rows = row ? await listBridgeLinksForServer(BRIDGE_PLUGIN_ID, serverId) : [];
    const counts = {
      paired: rows.filter((r) => r.serverLinkId === row?.id && !r.excluded && r.webhookId !== null).length,
      excluded: rows.filter((r) => r.serverLinkId === row?.id && r.excluded).length,
      manual: rows.filter((r) => r.serverLinkId === null).length
    };

    if (!isBridgePluginLoaded()) {
      return {
        available: false,
        configured: false,
        connected: false,
        botUser: null,
        lastError: null,
        link: row ? toBridgeServerLinkView(row) : null,
        remoteGuildName: null,
        counts,
        sync: getServerBridgeSyncState(serverId, row?.lastReport)
      };
    }

    const status = await pluginStatus({
      serverIds: [serverId],
      guildIds: row ? [row.remoteGuildId] : []
    });

    if (row) {
      await pushServerLinkToPlugin(row).catch(() => undefined);

      const liveRows = rows.filter((r) => !r.excluded && r.webhookId !== null);
      const known = new Set(
        Object.entries(status.links)
          .filter(([, live]) => live.known)
          .map(([channelId]) => Number(channelId))
      );

      for (const r of liveRows) {
        if (known.has(r.channelId)) continue;
        await callBridgePlugin('links/upsert', {
          channelId: r.channelId,
          serverId,
          remoteGuildId: r.remoteGuildId,
          remoteChannelId: r.remoteChannelId,
          direction: r.direction,
          webhookId: r.webhookId,
          webhookToken: readBridgeWebhookToken(r)
        }).catch(() => undefined);
      }

      const onRecord = new Set(liveRows.map((r) => r.channelId));
      for (const channelId of known) {
        if (onRecord.has(channelId)) continue;
        await callBridgePlugin('links/remove', { channelId }).catch(() => undefined);
      }

      noteSyncRequest(serverId, status.syncRequested?.[String(serverId)], 'status');
    }

    return {
      available: true,
      configured: status.configured,
      connected: status.connected,
      botUser: status.botUser,
      lastError: status.fatal ?? status.lastError,
      link: row ? toBridgeServerLinkView(row) : null,
      remoteGuildName: row ? (status.guilds?.[row.remoteGuildId]?.name ?? null) : null,
      counts,
      sync: getServerBridgeSyncState(serverId, row?.lastReport)
    };
  }
);

export { bridgeStatusRoute };
