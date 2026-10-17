import { Permission } from '@pulse/shared';
import { z } from 'zod';
import type { TBridgeStatus } from '../../types';
import {
  getBridgeLinkByChannelId,
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
};

/**
 * What the Bridge tab shows: whether the plugin runs at all (the tab
 * is offered only then), the link on record, and the plugin's live
 * view of it. The two copies are reconciled here, the one place both
 * are in hand: a link the server has but the plugin lost (its state
 * file gone) is pushed again with the decrypted token; a link the
 * plugin holds but the server dropped (unlinked while the plugin was
 * down) is removed from the plugin.
 */
const bridgeStatusRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(z.object({ channelId: z.number().int().positive() }))
  .query(async ({ ctx, input }): Promise<TBridgeStatus> => {
    const channel = await loadScopedChannel(input.channelId, ctx.activeServerId);
    const row = await getBridgeLinkByChannelId(BRIDGE_PLUGIN_ID, channel.id);
    const link = row ? toBridgeLinkView(row) : null;
    const bridgeable = !channel.e2ee && channel.type === 'TEXT';

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
        linkError: null
      };
    }

    const status = await callBridgePlugin<TPluginStatus>('status', { channelIds: [channel.id] });
    let live = status.links[String(channel.id)] ?? { known: false, mirroredToday: 0, lastError: null };

    if (row && !live.known) {
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
    } else if (!row && live.known) {
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
      linkError: live.lastError
    };
  });

export { bridgeStatusRoute };
