import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '..';
import {
  dmMessageFiles,
  dmMessageReactions,
  dmMessages,
  messageFiles,
  messageReactions,
  messages,
  pluginMessageLinks,
  polls
} from '../schema';
import { removeFile } from './files';

/**
 * Deleting a message leaves a tombstone (owner decision D55): the row
 * stays, marked `deletedAt` + `deletedBy`, and everything the message
 * carried goes — attachments (through removeFile, so the orphan scan and
 * the disk agree), reactions, link previews and the webhook persona in
 * `metadata`, mentions (so unread/mention counts stop seeing it), the
 * forward header and the pin. A poll's rows go with its message and a
 * plugin's link row is released so the externalId may be posted again,
 * exactly as the old ON DELETE CASCADE did. `replyToId`, `threadId` and
 * `type` are kept: a reply still points at its (now deleted) target, a
 * thread keeps its root, and the row keeps its place in the list.
 *
 * The retention sweep (crons/tombstones.ts) hard-deletes the row after
 * `config.server.tombstoneRetentionDays`. What a deletion leaves is
 * typed as TMessageTombstone in types.ts (the fan-out payload shape).
 */
const CLEARED_MESSAGE = {
  content: null,
  metadata: null,
  mentionedUserIds: null,
  mentionsAll: false,
  edited: false,
  pinned: false,
  pinnedAt: null,
  pinnedBy: null,
  forwardedFromUserId: null,
  forwardedFromName: null
} as const;

/**
 * Tombstone every live message in `messageIds`; rows that are already
 * tombstones are left as they are. Returns the ids that were
 * tombstoned by this call, so a caller can fan out exactly those.
 */
const tombstoneMessages = async (
  messageIds: number[],
  deletedBy: number | null,
  now: number = Date.now()
): Promise<number[]> => {
  if (messageIds.length === 0) return [];

  const live = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(inArray(messages.id, messageIds), isNull(messages.deletedAt)));
  const ids = live.map((row) => row.id);
  if (ids.length === 0) return [];

  const fileRows = await db
    .select({ fileId: messageFiles.fileId })
    .from(messageFiles)
    .where(inArray(messageFiles.messageId, ids));
  for (const { fileId } of fileRows) {
    await removeFile(fileId);
  }

  await db.delete(messageReactions).where(inArray(messageReactions.messageId, ids));
  await db.delete(polls).where(inArray(polls.messageId, ids));
  await db.delete(pluginMessageLinks).where(inArray(pluginMessageLinks.messageId, ids));

  const marked = await db
    .update(messages)
    .set({ ...CLEARED_MESSAGE, deletedAt: now, deletedBy })
    .where(and(inArray(messages.id, ids), isNull(messages.deletedAt)))
    .returning({ id: messages.id });

  return marked.map((row) => row.id);
};

/**
 * The DM twin of tombstoneMessages for one row. Ciphertext is cleared
 * like plaintext: an encrypted tombstone keeps nothing a sender key
 * could still open.
 */
const tombstoneDmMessage = async (
  messageId: number,
  deletedBy: number | null,
  now: number = Date.now()
): Promise<boolean> => {
  const attached = await db
    .select({ fileId: dmMessageFiles.fileId })
    .from(dmMessageFiles)
    .where(eq(dmMessageFiles.dmMessageId, messageId));
  for (const { fileId } of attached) {
    await removeFile(fileId);
  }
  // The pivot cascades with the file row; this also clears a pivot
  // whose file row was already gone.
  await db.delete(dmMessageFiles).where(eq(dmMessageFiles.dmMessageId, messageId));
  await db
    .delete(dmMessageReactions)
    .where(eq(dmMessageReactions.dmMessageId, messageId));

  const marked = await db
    .update(dmMessages)
    .set({ ...CLEARED_MESSAGE, deletedAt: now, deletedBy })
    .where(and(eq(dmMessages.id, messageId), isNull(dmMessages.deletedAt)))
    .returning({ id: dmMessages.id });

  return marked.length === 1;
};

export { tombstoneDmMessage, tombstoneMessages };
