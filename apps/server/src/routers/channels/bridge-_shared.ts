import { ChannelType } from '@pulse/shared';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels } from '../../db/schema';
import { pluginManager } from '../../plugins';
import { pluginHttp } from '../../plugins/http';
import { invariant } from '../../utils/invariant';

/**
 * Shared pieces of the channel bridge routes.
 *
 * The bridge is an official plugin; the server never talks to the
 * remote service itself. The routes here own the record (bridge_links)
 * and the permission check, and hand the actual work — listing remote
 * channels, creating the webhook, keeping the runtime copy — to the
 * plugin through the HTTP handlers it registered. The call is made
 * in-process (the registry hands us the handler), so the plugin's
 * endpoint secret is not involved: it guards callers from outside the
 * process, and this one never leaves it.
 */

const BRIDGE_PLUGIN_ID = 'discord-bridge';

/** Remote ids are snowflakes: decimal strings, at most 20 digits. */
const remoteIdSchema = z.string().regex(/^\d{1,20}$/, 'Invalid remote id');

const directionSchema = z.enum(['both', 'inbound', 'outbound']);

const isBridgePluginLoaded = () => pluginManager.isPluginLoaded(BRIDGE_PLUGIN_ID);

type TPluginError = { error?: unknown };

/**
 * Invoke one of the plugin's registered routes. A missing plugin or
 * route is PRECONDITION_FAILED (the tab is only offered while the
 * plugin runs); an error status the plugin answers with becomes a
 * BAD_REQUEST carrying its message, so the owner reads "Could not
 * create the webhook: Missing Access" instead of a generic failure.
 */
const callBridgePlugin = async <T>(path: string, body: unknown): Promise<T> => {
  invariant(isBridgePluginLoaded(), {
    code: 'PRECONDITION_FAILED',
    message: 'The bridge plugin is not running'
  });

  const handler = pluginHttp.get(BRIDGE_PLUGIN_ID, path);

  invariant(handler, {
    code: 'PRECONDITION_FAILED',
    message: 'The bridge plugin is not ready'
  });

  const response = await handler({ method: 'POST', path, headers: {}, query: {}, body });

  if (response.status >= 400) {
    const detail = response.body as TPluginError | undefined;
    const message =
      detail && typeof detail.error === 'string' ? detail.error : 'The bridge plugin refused';

    throw new TRPCError({
      code: response.status === 409 ? 'CONFLICT' : 'BAD_REQUEST',
      message
    });
  }

  return response.body as T;
};

/**
 * The channel a bridge route acts on, scoped to the caller's active
 * server (a channel elsewhere is NOT_FOUND, not an oracle).
 */
const loadScopedChannel = async (channelId: number, activeServerId: number) => {
  const [channel] = await db
    .select({
      id: channels.id,
      serverId: channels.serverId,
      type: channels.type,
      e2ee: channels.e2ee,
      name: channels.name
    })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.serverId, activeServerId)))
    .limit(1);

  invariant(channel, {
    code: 'NOT_FOUND',
    message: 'Channel not found'
  });

  return channel;
};

/**
 * Which channels can be bridged: plaintext text channels. Encrypted
 * ones are refused in plain words — the server cannot read their
 * messages, so it cannot mirror them; voice has no text and a forum's
 * own row holds posts, not messages; threads follow their parent link.
 */
const assertBridgeable = (channel: { type: string; e2ee: boolean }) => {
  invariant(!channel.e2ee, {
    code: 'BAD_REQUEST',
    message:
      'This channel is end-to-end encrypted. The server cannot read its messages, so it cannot mirror them to another service.'
  });

  invariant(channel.type === ChannelType.TEXT, {
    code: 'BAD_REQUEST',
    message: 'Only text channels can be bridged; threads under a bridged channel follow it automatically.'
  });
};

export {
  assertBridgeable,
  BRIDGE_PLUGIN_ID,
  callBridgePlugin,
  directionSchema,
  isBridgePluginLoaded,
  loadScopedChannel,
  remoteIdSchema
};
