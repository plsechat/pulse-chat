import {
  decryptChannelMessage,
  fetchAndProcessPendingSenderKeys
} from '@/lib/e2ee';
import { setFileKeys } from '@/lib/e2ee/file-key-store';
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
  channelId: number
): Promise<NonNullable<TJoinedMessage['replyTo']> | null | undefined> {
  if (!replyTo || !replyTo.e2ee || !replyTo.content) return replyTo;
  try {
    const payload = await decryptChannelMessage(
      channelId,
      replyTo.userId,
      replyTo.content
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
  await Promise.all(
    [...e2eeChannelIds].map((channelId) =>
      fetchAndProcessPendingSenderKeys(channelId)
    )
  );

  return Promise.all(
    messages.map(async (msg) => {
      const replyTo = await maybeDecryptReplyTo(msg.replyTo, msg.channelId);

      if (!msg.e2ee || !msg.content) {
        return replyTo === msg.replyTo ? msg : { ...msg, replyTo };
      }

      try {
        const payload = await decryptChannelMessage(
          msg.channelId,
          msg.userId,
          msg.content
        );
        setFileKeys(msg.id, payload.fileKeys);
        return { ...msg, content: payload.content, replyTo };
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
