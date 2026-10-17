import type { TBridgeDirection, TBridgeLink, TBridgeLinkView } from '../../types';
import { and, eq } from 'drizzle-orm';
import { db } from '..';
import { decryptImportToken, encryptImportToken } from '../../import/token-crypto';
import { bridgeLinks } from '../schema';

/**
 * bridge_links: which local channel an official bridge plugin mirrors
 * to which remote channel, and the webhook it posts through.
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
 */

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

const insertBridgeLink = async (values: {
  pluginId: string;
  channelId: number;
  remoteGuildId: string;
  remoteChannelId: string;
  webhookId: string;
  webhookToken: string | null;
  direction: TBridgeDirection;
  createdBy: number;
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
  direction: row.direction,
  createdBy: row.createdBy,
  createdAt: row.createdAt
});

export {
  deleteBridgeLink,
  getBridgeLinkByChannelId,
  getBridgeLinkByRemoteChannelId,
  insertBridgeLink,
  readBridgeWebhookToken,
  toBridgeLinkView,
  updateBridgeLinkDirection
};
