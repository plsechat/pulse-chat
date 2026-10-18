import { Permission } from '@pulse/shared';
import { z } from 'zod';
import {
  deleteBridgeLink,
  getBridgeLinkByChannelId,
  getBridgeLinkByRemoteChannelId,
  insertBridgeLink,
  readBridgeWebhookToken,
  toBridgeLinkView,
  updateBridgeLinkDirection
} from '../../db/queries/bridge-links';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import {
  assertBridgeable,
  BRIDGE_PLUGIN_ID,
  callBridgePlugin,
  directionSchema,
  loadScopedChannel,
  remoteIdSchema
} from './bridge-_shared';

type TUpsertAnswer = { webhookId: string; webhookToken: string | null };

/**
 * Link (or re-link) a channel to a remote one. Same remote channel as
 * the existing link → only the direction changes; a different one →
 * the old link is torn down (its webhook deleted) and a new webhook is
 * created on the new channel through the bot. The plugin creates the
 * webhook and hands the token back exactly once; the row stores it
 * encrypted and the response carries the view without it.
 */
const bridgeLinkRoute = serverProcedure(Permission.MANAGE_CHANNELS)
  .input(
    z.object({
      channelId: z.number().int().positive(),
      remoteGuildId: remoteIdSchema,
      remoteChannelId: remoteIdSchema,
      direction: directionSchema.default('both')
    })
  )
  .mutation(async ({ ctx, input }) => {
    const channel = await loadScopedChannel(input.channelId, ctx.activeServerId);
    assertBridgeable(channel);

    const existing = await getBridgeLinkByChannelId(BRIDGE_PLUGIN_ID, channel.id);

    if (existing && existing.remoteChannelId === input.remoteChannelId) {
      // Direction change only: re-push the link with its known webhook
      // so the plugin creates nothing new.
      await callBridgePlugin<TUpsertAnswer>('links/upsert', {
        channelId: channel.id,
        serverId: channel.serverId,
        remoteGuildId: existing.remoteGuildId,
        remoteChannelId: existing.remoteChannelId,
        direction: input.direction,
        webhookId: existing.webhookId,
        webhookToken: readBridgeWebhookToken(existing)
      });

      const updated = await updateBridgeLinkDirection(existing.id, input.direction);

      invariant(updated, { code: 'NOT_FOUND', message: 'Bridge link not found' });

      return toBridgeLinkView(updated);
    }

    const taken = await getBridgeLinkByRemoteChannelId(BRIDGE_PLUGIN_ID, input.remoteChannelId);

    invariant(!taken, {
      code: 'CONFLICT',
      message: 'That remote channel is already bridged to another channel here'
    });

    if (existing) {
      await deleteBridgeLink(existing.id);
      await callBridgePlugin('links/remove', { channelId: channel.id });
    }

    const answer = await callBridgePlugin<TUpsertAnswer>('links/upsert', {
      channelId: channel.id,
      serverId: channel.serverId,
      remoteGuildId: input.remoteGuildId,
      remoteChannelId: input.remoteChannelId,
      direction: input.direction
    });

    invariant(typeof answer?.webhookId === 'string' && answer.webhookId.length > 0, {
      code: 'BAD_REQUEST',
      message: 'The bridge plugin did not return a webhook'
    });

    let row;

    try {
      row = await insertBridgeLink({
        pluginId: BRIDGE_PLUGIN_ID,
        channelId: channel.id,
        remoteGuildId: input.remoteGuildId,
        remoteChannelId: input.remoteChannelId,
        webhookId: answer.webhookId,
        webhookToken: typeof answer.webhookToken === 'string' ? answer.webhookToken : null,
        direction: input.direction,
        createdBy: ctx.user.id
      });
    } catch (error) {
      // A concurrent link won the unique index: undo the webhook we
      // just had created and report the conflict.
      await callBridgePlugin('links/remove', { channelId: channel.id }).catch(() => undefined);
      throw error;
    }

    return toBridgeLinkView(row);
  });

export { bridgeLinkRoute };
