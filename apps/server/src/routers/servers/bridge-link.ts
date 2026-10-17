import { Permission } from '@pulse/shared';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { TBridgeServerLinkView } from '../../types';
import {
  getBridgeServerLink,
  getBridgeServerLinkByGuild,
  insertBridgeServerLink,
  readBridgeWebhookToken,
  retargetBridgeLinkDirections,
  toBridgeServerLinkView,
  updateBridgeServerLink
} from '../../db/queries/bridge-links';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import {
  BRIDGE_PLUGIN_ID,
  callBridgePlugin,
  directionSchema,
  remoteIdSchema
} from '../channels/bridge-_shared';
import {
  createMissingSchema,
  listRemoteGuilds,
  modeSchema,
  pushServerLinkToPlugin
} from './bridge-_shared';
import { syncServerBridge } from './bridge-sync';
import { unlinkServerBridge } from './bridge-unlink';

/**
 * Link the active server to a remote server, or change how an existing
 * link pairs channels. Same remote server → the settings change in
 * place: channels that still carried the previous default direction
 * follow the new one (an override set on a channel's own tab stays), and
 * a sync runs so a mode switch to `mirror` creates what is missing. A
 * different remote server → the old link is torn down first (every pair
 * and webhook), then the new one is made. Either way the sync runs in
 * the background; the view returns at once and the status shows the run.
 */
const bridgeLinkRoute = serverProcedure(Permission.MANAGE_SETTINGS)
  .input(
    z.object({
      remoteGuildId: remoteIdSchema,
      mode: modeSchema.default('match'),
      createMissing: createMissingSchema.default('none'),
      defaultDirection: directionSchema.default('both')
    })
  )
  .mutation(async ({ ctx, input }): Promise<TBridgeServerLinkView> => {
    const settings = {
      mode: input.mode,
      // Match mode never creates anything; store what the mode means.
      createMissing: input.mode === 'mirror' ? input.createMissing : ('none' as const),
      defaultDirection: input.defaultDirection
    };

    const existing = await getBridgeServerLink(BRIDGE_PLUGIN_ID, ctx.activeServerId);

    if (existing && existing.remoteGuildId === input.remoteGuildId) {
      const updated = await updateBridgeServerLink(existing.id, settings);
      invariant(updated, { code: 'NOT_FOUND', message: 'This server is not linked to a remote server' });

      const moved = await retargetBridgeLinkDirections(
        existing.id,
        existing.defaultDirection,
        settings.defaultDirection
      );

      for (const row of moved) {
        // Re-push with the known webhook so the plugin creates nothing new.
        await callBridgePlugin('links/upsert', {
          channelId: row.channelId,
          serverId: ctx.activeServerId,
          remoteGuildId: row.remoteGuildId,
          remoteChannelId: row.remoteChannelId,
          direction: row.direction,
          webhookId: row.webhookId,
          webhookToken: readBridgeWebhookToken(row)
        }).catch(() => undefined);
      }

      await pushServerLinkToPlugin(updated);
      void syncServerBridge(ctx.activeServerId, 'link');

      return toBridgeServerLinkView(updated);
    }

    const taken = await getBridgeServerLinkByGuild(BRIDGE_PLUGIN_ID, input.remoteGuildId);

    invariant(!taken, {
      code: 'CONFLICT',
      message: 'That remote server is already linked to another community here'
    });

    // The bot must sit in the server: one listing through the plugin,
    // which also surfaces "no bot token" before anything is stored.
    const guilds = await listRemoteGuilds();

    invariant(
      guilds.some((guild) => guild.id === input.remoteGuildId),
      {
        code: 'BAD_REQUEST',
        message: 'The bot is not in that server. Add it there first, then reload the list.'
      }
    );

    if (existing) {
      await unlinkServerBridge(existing);
    }

    let row;

    try {
      row = await insertBridgeServerLink({
        pluginId: BRIDGE_PLUGIN_ID,
        serverId: ctx.activeServerId,
        remoteGuildId: input.remoteGuildId,
        ...settings,
        createdBy: ctx.user.id
      });
    } catch {
      // A concurrent link won one of the unique indexes.
      throw new TRPCError({
        code: 'CONFLICT',
        message: 'That remote server is already linked to another community here'
      });
    }

    await pushServerLinkToPlugin(row);
    void syncServerBridge(ctx.activeServerId, 'link');

    return toBridgeServerLinkView(row);
  });

export { bridgeLinkRoute };
