import { Permission } from '@pulse/shared';
import { z } from 'zod';
import type { TBridgeStatus } from '../../types';
import {
  getBridgeLinkByChannelId,
  getBridgeServerLink,
  readBridgeWebhookToken,
  toBridgeLinkView
} from '../../db/queries/bridge-links';
import { serverProcedure } from '../../utils/procedures';
import {
  BRIDGE_PLUGIN_ID,
  callBridgePlugin,
  isBridgePluginLoaded,
  loadScopedChannel
} from './bridge-_shared';

type TPluginStatus = {
  configured: boolean;
  connected: boolean;
  fatal: string | null;
  lastError: string | null;
  botUser: { id: string; name: string } | null;
  links: Record<string, { known: boolean; mirroredToday: number; lastError: string | null }>;
  guilds?: Record<string, { name: string }>;
};

/**
 * What the Bridge tab shows: whether the plugin runs at all (the tab
 * is offered only then), the link on record, and the plugin's live
 * view of it. The two copies are reconciled here, the one place both
 * are in hand: a link the server has but the plugin lost (its state
 * file gone) is pushed again with the decrypted token; a link the
 * plugin holds but the server dropped (unlinked while the plugin was
 * down) is removed from the plugin. The server link the channel falls
 * under (if any) rides along so the tab can show the pair as part of it
 * and offer Exclude instead of Unlink.
 */
const bridgeStatusRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(z.object({ channelId: z.number().int().positive() }))
  .query(async ({ ctx, input }): Promise<TBridgeStatus> => {
    const channel = await loadScopedChannel(input.channelId, ctx.activeServerId);
    const row = await getBridgeLinkByChannelId(BRIDGE_PLUGIN_ID, channel.id);
    const link = row ? toBridgeLinkView(row) : null;
    const bridgeable = !channel.e2ee && channel.type === 'TEXT';
    const serverRow = await getBridgeServerLink(BRIDGE_PLUGIN_ID, channel.serverId);
    const serverLink = (remoteGuildName: string | null) =>
      serverRow
        ? {
            id: serverRow.id,
            remoteGuildId: serverRow.remoteGuildId,
            remoteGuildName,
            mode: serverRow.mode,
            defaultDirection: serverRow.defaultDirection
          }
        : null;

    if (!isBridgePluginLoaded()) {
      return {
        available: false,
        bridgeable,
        configured: false,
        connected: false,
        botUser: null,
        lastError: null,
        link,
        mirroredToday: 0,
        linkError: null,
        serverLink: serverLink(null)
      };
    }

    const status = await callBridgePlugin<TPluginStatus>('status', {
      channelIds: [channel.id],
      guildIds: serverRow ? [serverRow.remoteGuildId] : []
    });
    let live = status.links[String(channel.id)] ?? { known: false, mirroredToday: 0, lastError: null };

    // An excluded row has no webhook: nothing for the plugin to hold.
    if (row && !row.excluded && row.webhookId !== null && !live.known) {
      await callBridgePlugin('links/upsert', {
        channelId: row.channelId,
        serverId: channel.serverId,
        remoteGuildId: row.remoteGuildId,
        remoteChannelId: row.remoteChannelId,
        direction: row.direction,
        webhookId: row.webhookId,
        webhookToken: readBridgeWebhookToken(row)
      }).catch(() => undefined);
      live = { ...live, known: true };
    } else if ((!row || row.excluded) && live.known) {
      await callBridgePlugin('links/remove', { channelId: channel.id }).catch(() => undefined);
      live = { known: false, mirroredToday: 0, lastError: null };
    }

    return {
      available: true,
      bridgeable,
      configured: status.configured,
      connected: status.connected,
      botUser: status.botUser,
      lastError: status.fatal ?? status.lastError,
      link,
      mirroredToday: live.mirroredToday,
      linkError: live.lastError,
      serverLink: serverLink(serverRow ? (status.guilds?.[serverRow.remoteGuildId]?.name ?? null) : null)
    };
  });

export { bridgeStatusRoute };
