import type { TPluginMessageLink } from '../../types';
import { and, eq } from 'drizzle-orm';
import { db } from '..';
import { pluginMessageLinks } from '../schema';

/**
 * plugin_message_links: which channel messages a plugin posted, keyed by
 * the plugin's own id for them. Two jobs:
 *
 *  1. idempotency — a bridge that re-delivers an upstream message posts
 *     the same externalId twice and must get the same message back;
 *  2. ownership — `actions.messages.edit/delete/react` are scoped to the
 *     messages the plugin posted (unless it declares `moderate-messages`),
 *     and every plugin post is stored under the instance owner's user id,
 *     so the users row cannot tell plugin posts apart. The link row can.
 *
 * Rows cascade with their message, so a deleted message leaves no stale
 * claim behind.
 */

/** Ids a plugin may not choose: the loader mints `__auto:<uuid>` for posts without one. */
const RESERVED_EXTERNAL_ID_PREFIX = '__';

type TTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const getPluginMessageLinkByExternalId = async (
  pluginId: string,
  externalId: string
): Promise<TPluginMessageLink | undefined> => {
  const [row] = await db
    .select()
    .from(pluginMessageLinks)
    .where(
      and(
        eq(pluginMessageLinks.pluginId, pluginId),
        eq(pluginMessageLinks.externalId, externalId)
      )
    )
    .limit(1);

  return row;
};

const getPluginMessageLinkByMessageId = async (
  pluginId: string,
  messageId: number
): Promise<TPluginMessageLink | undefined> => {
  const [row] = await db
    .select()
    .from(pluginMessageLinks)
    .where(
      and(
        eq(pluginMessageLinks.pluginId, pluginId),
        eq(pluginMessageLinks.messageId, messageId)
      )
    )
    .limit(1);

  return row;
};

/**
 * Insert inside the caller's transaction so the message row and its
 * claim land together: a unique-index violation (two posts racing on
 * one externalId) rolls both back and the caller re-reads the winner.
 */
const insertPluginMessageLink = async (
  tx: TTransaction,
  values: {
    pluginId: string;
    externalId: string;
    messageId: number;
    channelId: number;
  }
): Promise<TPluginMessageLink> => {
  const [row] = await tx
    .insert(pluginMessageLinks)
    .values({ ...values, createdAt: Date.now() })
    .returning();

  return row!;
};

export {
  getPluginMessageLinkByExternalId,
  getPluginMessageLinkByMessageId,
  insertPluginMessageLink,
  RESERVED_EXTERNAL_ID_PREFIX
};
