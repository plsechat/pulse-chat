import type {
  TBridgeCreateMissing,
  TBridgeDirection,
  TBridgeLink,
  TBridgeLinkView,
  TBridgeMode,
  TBridgeServerLink,
  TBridgeServerLinkView
} from '../../types';
import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '..';
import { decryptImportToken, encryptImportToken } from '../../import/token-crypto';
import { bridgeLinks, bridgeServerLinks, channels } from '../schema';

/**
 * bridge_links: which local channel an official bridge plugin mirrors
 * to which remote channel, and the webhook it posts through.
 * bridge_server_links: a whole community linked to one remote server;
 * the per-channel rows it produced carry its id.
 *
 * The server is the record (the Bridge tab reads it, the cascade on
 * channel delete cleans it); the plugin keeps a runtime copy without
 * the secret. The webhook token is the one thing here that must not
 * leak: it lets anyone post into the remote channel under any name. It
 * is stored encrypted under the instance's file-signing secret — the
 * same construction the community import uses for its bot token — and
 * decrypted in exactly one place: when the server hands a link back to
 * the plugin in-process. No route returns it; `toBridgeLinkView` never
 * carries it.
 *
 * An EXCLUDED row is a channel the owner opted out of the server link:
 * it keeps its pair (so the sync knows not to re-add it) but no webhook
 * and no token. A channel excluded before it ever paired has no remote
 * channel to remember; its row carries `excludedPlaceholder(channelId)`
 * in that column, which the unique index tolerates and the sync treats
 * as "no pair".
 */

const EXCLUDED_PLACEHOLDER_PREFIX = 'excluded:';

/** The remote-channel column of an excluded row that never paired. */
const excludedPlaceholder = (channelId: number): string =>
  `${EXCLUDED_PLACEHOLDER_PREFIX}${channelId}`;

const getBridgeLinkByChannelId = async (
  pluginId: string,
  channelId: number
): Promise<TBridgeLink | undefined> => {
  const [row] = await db
    .select()
    .from(bridgeLinks)
    .where(and(eq(bridgeLinks.pluginId, pluginId), eq(bridgeLinks.channelId, channelId)))
    .limit(1);

  return row;
};

const getBridgeLinkByRemoteChannelId = async (
  pluginId: string,
  remoteChannelId: string
): Promise<TBridgeLink | undefined> => {
  const [row] = await db
    .select()
    .from(bridgeLinks)
    .where(
      and(eq(bridgeLinks.pluginId, pluginId), eq(bridgeLinks.remoteChannelId, remoteChannelId))
    )
    .limit(1);

  return row;
};

/** Every link row of a server's channels (manual, server-linked and excluded alike). */
const listBridgeLinksForServer = async (
  pluginId: string,
  serverId: number
): Promise<TBridgeLink[]> => {
  const rows = await db
    .select({ link: bridgeLinks })
    .from(bridgeLinks)
    .innerJoin(channels, eq(channels.id, bridgeLinks.channelId))
    .where(and(eq(bridgeLinks.pluginId, pluginId), eq(channels.serverId, serverId)))
    .limit(2000);

  return rows.map((row) => row.link);
};

const insertBridgeLink = async (values: {
  pluginId: string;
  channelId: number;
  remoteGuildId: string;
  remoteChannelId: string;
  webhookId: string;
  webhookToken: string | null;
  direction: TBridgeDirection;
  createdBy: number | null;
  serverLinkId?: number | null;
}): Promise<TBridgeLink> => {
  const [row] = await db
    .insert(bridgeLinks)
    .values({
      pluginId: values.pluginId,
      channelId: values.channelId,
      remoteGuildId: values.remoteGuildId,
      remoteChannelId: values.remoteChannelId,
      webhookId: values.webhookId,
      webhookTokenCiphertext:
        values.webhookToken !== null ? encryptImportToken(values.webhookToken) : null,
      direction: values.direction,
      createdBy: values.createdBy,
      serverLinkId: values.serverLinkId ?? null,
      excluded: false,
      createdAt: Date.now()
    })
    .returning();

  return row!;
};

/** An opted-out row for a channel that never paired under the server link. */
const insertExcludedBridgeLink = async (values: {
  pluginId: string;
  channelId: number;
  remoteGuildId: string;
  serverLinkId: number;
  createdBy: number | null;
}): Promise<TBridgeLink> => {
  const [row] = await db
    .insert(bridgeLinks)
    .values({
      pluginId: values.pluginId,
      channelId: values.channelId,
      remoteGuildId: values.remoteGuildId,
      remoteChannelId: excludedPlaceholder(values.channelId),
      webhookId: null,
      webhookTokenCiphertext: null,
      direction: 'both',
      createdBy: values.createdBy,
      serverLinkId: values.serverLinkId,
      excluded: true,
      createdAt: Date.now()
    })
    .returning();

  return row!;
};

const updateBridgeLinkDirection = async (
  id: number,
  direction: TBridgeDirection
): Promise<TBridgeLink | undefined> => {
  const [row] = await db
    .update(bridgeLinks)
    .set({ direction })
    .where(eq(bridgeLinks.id, id))
    .returning();

  return row;
};

/**
 * Opt a paired row out: the pair is remembered, the webhook forgotten
 * (the plugin deletes it; the row must not keep a token for a webhook
 * that no longer exists).
 */
const markBridgeLinkExcluded = async (id: number): Promise<TBridgeLink | undefined> => {
  const [row] = await db
    .update(bridgeLinks)
    .set({ excluded: true, webhookId: null, webhookTokenCiphertext: null })
    .where(eq(bridgeLinks.id, id))
    .returning();

  return row;
};

/**
 * Move every server-linked, non-excluded row that still carried the
 * previous default to the new one. A row on another direction was set
 * by hand on the channel tab and keeps its override.
 */
const retargetBridgeLinkDirections = async (
  serverLinkId: number,
  from: TBridgeDirection,
  to: TBridgeDirection
): Promise<TBridgeLink[]> => {
  if (from === to) return [];

  return db
    .update(bridgeLinks)
    .set({ direction: to })
    .where(
      and(
        eq(bridgeLinks.serverLinkId, serverLinkId),
        eq(bridgeLinks.excluded, false),
        eq(bridgeLinks.direction, from),
        isNotNull(bridgeLinks.webhookId)
      )
    )
    .returning();
};

const deleteBridgeLink = async (id: number): Promise<void> => {
  await db.delete(bridgeLinks).where(eq(bridgeLinks.id, id));
};

/** The plaintext webhook token of a row, for the in-process hand-off to the plugin only. */
const readBridgeWebhookToken = (row: TBridgeLink): string | null => {
  if (!row.webhookTokenCiphertext) return null;

  try {
    return decryptImportToken(row.webhookTokenCiphertext);
  } catch {
    // A ciphertext from another instance (different secret) or a
    // damaged row: the plugin re-resolves the token through the bot.
    return null;
  }
};

/** What a client may see: never the ciphertext, never the plugin id. */
const toBridgeLinkView = (row: TBridgeLink): TBridgeLinkView => ({
  id: row.id,
  channelId: row.channelId,
  remoteGuildId: row.remoteGuildId,
  remoteChannelId: row.remoteChannelId,
  webhookId: row.webhookId,
  serverLinkId: row.serverLinkId,
  excluded: row.excluded,
  direction: row.direction,
  createdBy: row.createdBy,
  createdAt: row.createdAt
});

// ─── server links ─────────────────────────────────────────────────────

const getBridgeServerLink = async (
  pluginId: string,
  serverId: number
): Promise<TBridgeServerLink | undefined> => {
  const [row] = await db
    .select()
    .from(bridgeServerLinks)
    .where(
      and(eq(bridgeServerLinks.pluginId, pluginId), eq(bridgeServerLinks.serverId, serverId))
    )
    .limit(1);

  return row;
};

const getBridgeServerLinkByGuild = async (
  pluginId: string,
  remoteGuildId: string
): Promise<TBridgeServerLink | undefined> => {
  const [row] = await db
    .select()
    .from(bridgeServerLinks)
    .where(
      and(
        eq(bridgeServerLinks.pluginId, pluginId),
        eq(bridgeServerLinks.remoteGuildId, remoteGuildId)
      )
    )
    .limit(1);

  return row;
};

/** Every server link of the plugin, for the periodic reconcile tick. */
const listBridgeServerLinks = async (pluginId: string): Promise<TBridgeServerLink[]> =>
  db
    .select()
    .from(bridgeServerLinks)
    .where(eq(bridgeServerLinks.pluginId, pluginId))
    .limit(1000);

const insertBridgeServerLink = async (values: {
  pluginId: string;
  serverId: number;
  remoteGuildId: string;
  mode: TBridgeMode;
  createMissing: TBridgeCreateMissing;
  defaultDirection: TBridgeDirection;
  createdBy: number;
}): Promise<TBridgeServerLink> => {
  const [row] = await db
    .insert(bridgeServerLinks)
    .values({ ...values, createdAt: Date.now() })
    .returning();

  return row!;
};

const updateBridgeServerLink = async (
  id: number,
  patch: {
    mode: TBridgeMode;
    createMissing: TBridgeCreateMissing;
    defaultDirection: TBridgeDirection;
  }
): Promise<TBridgeServerLink | undefined> => {
  const [row] = await db
    .update(bridgeServerLinks)
    .set(patch)
    .where(eq(bridgeServerLinks.id, id))
    .returning();

  return row;
};

/** Removes the server link; its channel rows go by cascade. */
const deleteBridgeServerLink = async (id: number): Promise<void> => {
  await db.delete(bridgeServerLinks).where(eq(bridgeServerLinks.id, id));
};

const toBridgeServerLinkView = (row: TBridgeServerLink): TBridgeServerLinkView => ({
  id: row.id,
  serverId: row.serverId,
  remoteGuildId: row.remoteGuildId,
  mode: row.mode,
  createMissing: row.createMissing,
  defaultDirection: row.defaultDirection,
  createdBy: row.createdBy,
  lastSyncAt: row.lastSyncAt,
  lastError: row.lastError,
  lastReport: row.lastReport,
  createdAt: row.createdAt
});

export {
  deleteBridgeLink,
  deleteBridgeServerLink,
  getBridgeLinkByChannelId,
  getBridgeLinkByRemoteChannelId,
  getBridgeServerLink,
  getBridgeServerLinkByGuild,
  insertBridgeLink,
  insertBridgeServerLink,
  insertExcludedBridgeLink,
  listBridgeLinksForServer,
  listBridgeServerLinks,
  markBridgeLinkExcluded,
  readBridgeWebhookToken,
  retargetBridgeLinkDirections,
  toBridgeLinkView,
  toBridgeServerLinkView,
  updateBridgeLinkDirection,
  updateBridgeServerLink
};
