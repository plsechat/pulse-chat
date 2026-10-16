import {
  decryptChannelMessage,
  fetchAndProcessPendingSenderKeys,
  loadPersistedChannelPlaintexts,
  type PersistedPlaintextRef
} from '@/lib/e2ee';
import type { PersistedSkPlaintext } from '@/lib/e2ee/plaintext-cache';
import {
  patchFilesWithE2eeMetadata,
  setFileKeys
} from '@/lib/e2ee/file-key-store';
import type { TJoinedMessage } from '@pulse/shared';

/**
 * Single source of truth for "decrypt a batch of channel messages for
 * display." Used by every consumer that fetches channel messages from
 * the server: history pagination, live subscriptions, pin banner,
 * pinned-panel. Routing new fetchers through this avoids the bug
 * class where a path forgets to decrypt and shows raw envelope bytes.
 *
 * Channel encryption is sender-key (AES-GCM), idempotent under repeat,
 * so we can safely decrypt the same ciphertext multiple times — that
 * makes the replyTo decrypt unconditional and unproblematic, unlike
 * the DM 1:1 pairwise case.
 */
async function maybeDecryptReplyTo(
  replyTo: NonNullable<TJoinedMessage['replyTo']> | null | undefined,
  channelId: number,
  persisted: ReadonlyMap<number, PersistedSkPlaintext>
): Promise<NonNullable<TJoinedMessage['replyTo']> | null | undefined> {
  if (!replyTo || !replyTo.e2ee || !replyTo.content) return replyTo;
  try {
    const payload = await decryptChannelMessage(
      channelId,
      replyTo.userId,
      replyTo.content,
      replyTo.id,
      persisted
    );
    return { ...replyTo, content: payload.content };
  } catch {
    return { ...replyTo, content: '[Unable to decrypt]' };
  }
}

export async function decryptChannelMessages(
  messages: TJoinedMessage[]
): Promise<TJoinedMessage[]> {
  // Pre-fetch all pending sender keys for channels in this batch so that
  // the per-message decryptChannelMessage calls hit the in-memory cache
  // instead of each independently fetching from the server.
  const e2eeChannelIds = new Set(
    messages.filter((m) => m.e2ee && m.content).map((m) => m.channelId)
  );
  // One IDB read for every encrypted id in the batch (messages + their
  // encrypted replyTo targets) instead of one per decryptChannelMessage
  // call; a page that was already decrypted once never touches the
  // chain again. The author id rides along so own messages can use
  // the legacy-row fallback.
  const persistedRefs = new Map<number, PersistedPlaintextRef>();
  for (const m of messages) {
    if (m.e2ee && m.content) {
      persistedRefs.set(m.id, { id: m.id, fromUserId: m.userId });
    }
    if (m.replyTo?.e2ee && m.replyTo.content) {
      persistedRefs.set(m.replyTo.id, {
        id: m.replyTo.id,
        fromUserId: m.replyTo.userId
      });
    }
  }
  const [persisted] = await Promise.all([
    loadPersistedChannelPlaintexts([...persistedRefs.values()]),
    ...[...e2eeChannelIds].map((channelId) =>
      fetchAndProcessPendingSenderKeys(channelId)
    )
  ]);

  return Promise.all(
    messages.map(async (msg) => {
      const replyTo = await maybeDecryptReplyTo(
        msg.replyTo,
        msg.channelId,
        persisted
      );

      if (!msg.e2ee || !msg.content) {
        return replyTo === msg.replyTo ? msg : { ...msg, replyTo };
      }

      try {
        const payload = await decryptChannelMessage(
          msg.channelId,
          msg.userId,
          msg.content,
          msg.id,
          persisted
        );
        setFileKeys(msg.id, payload.fileKeys);
        const files = patchFilesWithE2eeMetadata(msg.files, payload.fileKeys);
        return { ...msg, content: payload.content, files, replyTo };
      } catch (err) {
        console.error('[E2EE] Failed to decrypt channel message:', err);
        return { ...msg, content: '[Unable to decrypt]', replyTo };
      }
    })
  );
}

/**
 * Single-message convenience wrapper around decryptChannelMessages
 * for the live subscription path. Same semantics — a one-element
 * batch — so subscriptions and history can't drift out of sync.
 */
export async function decryptChannelMessageForDisplay(
  message: TJoinedMessage
): Promise<TJoinedMessage> {
  const [decrypted] = await decryptChannelMessages([message]);
  return decrypted ?? message;
}
