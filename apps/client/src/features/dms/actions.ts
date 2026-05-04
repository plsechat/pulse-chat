import {
  decryptDmGroupMessage,
  decryptDmMessage,
  encryptDmGroupMessage,
  encryptDmMessage,
  ensureDmGroupSenderKey,
  rotateDmGroupSenderKey
} from '@/lib/e2ee';
import type { E2EEPlaintext } from '@/lib/e2ee/types';
import { setFileKeys } from '@/lib/e2ee/file-key-store';
import { sendDesktopNotification } from '@/features/notifications/desktop-notification';
import { getHomeTRPCClient } from '@/lib/trpc';
import { toast } from 'sonner';
import { TYPING_MS, type TJoinedDmChannel, type TJoinedDmMessage } from '@pulse/shared';
import { setCurrentVoiceChannelId, setCurrentVoiceServerId } from '../server/channels/actions';
import { playSound } from '../server/sounds/actions';
import { SoundType } from '../server/types';
import { ownUserIdSelector } from '../server/users/selectors';
import { addUserToVoiceChannel } from '../server/voice/actions';
import { store } from '../store';
import { dmsSliceActions } from './slice';
import {
  deleteCachedPlaintext,
  getCachedPlaintext,
  getCachedPlaintextBatch,
  setCachedPlaintext,
  setCachedPlaintextBatch,
  type CachedDmPlaintext
} from './plaintext-cache';

export const setDmChannels = (channels: TJoinedDmChannel[]) =>
  store.dispatch(dmsSliceActions.setChannels(channels));

/** Mark a single DM channel as read on the server (fire-and-forget). */
const markDmChannelAsRead = (dmChannelId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  trpc.dms.markChannelAsRead.mutate({ dmChannelId }).catch(() => {
    // ignore errors — this is a best-effort background update
  });
};

export const addOrUpdateDmChannel = (channel: TJoinedDmChannel) =>
  store.dispatch(dmsSliceActions.addOrUpdateChannel(channel));

export const setSelectedDmChannelId = (channelId: number | undefined) =>
  store.dispatch(dmsSliceActions.setSelectedChannelId(channelId));

export const addDmMessages = (
  dmChannelId: number,
  messages: TJoinedDmMessage[],
  opts: { prepend?: boolean } = {},
  isSubscription = false
) => {
  if (isSubscription && messages.length > 0) {
    const state = store.getState();
    const ownUserId = ownUserIdSelector(state);
    const selectedId = state.dms.selectedChannelId;
    if (ownUserId != null && messages[0].userId !== ownUserId) {
      // selectedChannelId is sticky across navigation (kept so the user
      // returns to the same DM next time), so it alone can't tell us
      // whether the DM is *currently on screen*. Gate on activeView too:
      // if the user clicked into a server, home isn't the active view
      // and they should still get the notification.
      const isViewingThisChannel =
        state.app.activeView === 'home' && selectedId === dmChannelId;

      if (!isViewingThisChannel) {
        playSound(SoundType.MESSAGE_RECEIVED);

        const senderChannel = state.dms.channels.find((c) =>
          c.members.some((m) => m.id === messages[0].userId)
        );
        const senderName =
          senderChannel?.members.find((m) => m.id === messages[0].userId)
            ?.name;

        sendDesktopNotification(
          senderName ? `${senderName}` : 'New Direct Message',
          messages[0].content?.slice(0, 100) || 'New message received'
        );

        store.dispatch(dmsSliceActions.incrementChannelUnread(dmChannelId));
      } else {
        // User is viewing this DM — update server read state so
        // any future channel re-fetch won't resurrect unread badges
        markDmChannelAsRead(dmChannelId);
      }
    }
  }
  store.dispatch(dmsSliceActions.addMessages({ dmChannelId, messages, opts }));

  // Update the channel's lastMessage so the sidebar snippet stays current
  if (isSubscription && messages.length > 0) {
    const lastMsg = messages[messages.length - 1];
    store.dispatch(
      dmsSliceActions.updateChannelLastMessage({
        dmChannelId,
        lastMessage: lastMsg
      })
    );
  }
};

export const updateDmMessage = (message: TJoinedDmMessage) => {
  store.dispatch(dmsSliceActions.updateMessage(message));
  store.dispatch(
    dmsSliceActions.updateChannelLastMessage({
      dmChannelId: message.dmChannelId,
      lastMessage: message
    })
  );
};

export const deleteDmMessage = (dmChannelId: number, dmMessageId: number) => {
  store.dispatch(dmsSliceActions.deleteMessage({ dmChannelId, dmMessageId }));
};

export const setDmsLoading = (loading: boolean) =>
  store.dispatch(dmsSliceActions.setLoading(loading));

export const resetDmsState = () =>
  store.dispatch(dmsSliceActions.resetState());

/**
 * Decrypt the embedded `lastMessage` for E2EE channels.
 *
 * The server returns the libsignal envelope JSON in `content` for E2EE
 * messages. Without this pass, the sidebar preview shows the raw
 * `{"type":1,"body":"..."}` blob instead of the readable plaintext.
 *
 * Mirrors the per-message decrypt path used by `fetchDmMessages` /
 * `decryptDmMessageInPlace`, including the persistent IDB cache and the
 * own-message fallback (own ciphertext can't be self-decrypted via Signal —
 * we rely on the cache populated at send time).
 */
async function decryptDmChannelLastMessages(
  channels: TJoinedDmChannel[]
): Promise<TJoinedDmChannel[]> {
  return Promise.all(
    channels.map(async (channel) => {
      if (!channel.lastMessage) return channel;
      const decryptedLast = await decryptDmMessageInPlace(channel.lastMessage);
      if (decryptedLast === channel.lastMessage) return channel;
      return { ...channel, lastMessage: decryptedLast };
    })
  );
}

export const fetchDmChannels = async () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  setDmsLoading(true);
  try {
    const channels = await trpc.dms.getChannels.query();
    const decrypted = await decryptDmChannelLastMessages(channels);
    setDmChannels(decrypted);
  } catch (err) {
    console.error('Failed to fetch DM channels:', err);
  } finally {
    setDmsLoading(false);
  }
};

export const fetchActiveDmCalls = async () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  try {
    const activeCalls = await trpc.dms.getActiveCalls.query();
    for (const call of activeCalls) {
      store.dispatch(
        dmsSliceActions.dmCallStarted({
          dmChannelId: call.dmChannelId,
          startedBy: call.users[0]?.userId ?? 0
        })
      );
      for (const user of call.users) {
        store.dispatch(
          dmsSliceActions.dmCallUserJoined({
            dmChannelId: call.dmChannelId,
            userId: user.userId,
            state: user.state
          })
        );
        addUserToVoiceChannel(user.userId, call.dmChannelId, user.state);
      }
    }
  } catch (err) {
    console.error('Failed to fetch active DM calls:', err);
  }
};

export const getOrCreateDmChannel = async (
  userId: number
): Promise<TJoinedDmChannel | undefined> => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return undefined;
  try {
    const channel = await trpc.dms.getOrCreateChannel.mutate({ userId });
    const [decrypted] = await decryptDmChannelLastMessages([channel]);
    addOrUpdateDmChannel(decrypted);
    return decrypted;
  } catch (err) {
    console.error('Failed to get or create DM channel:', err);
  }
};

export const fetchDmMessages = async (
  dmChannelId: number,
  cursor?: number | null
) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return undefined;
  try {
    const result = await trpc.dms.getMessages.query({ dmChannelId, cursor });

    // Decrypt any E2EE messages
    const decryptedMessages = await decryptDmMessages(result.messages);
    addDmMessages(dmChannelId, decryptedMessages, { prepend: !!cursor });

    // Clear unread badge when fetching the first page (user opened the channel)
    if (!cursor) {
      store.dispatch(dmsSliceActions.clearChannelUnread(dmChannelId));
      markDmChannelAsRead(dmChannelId);
    }

    return result.nextCursor;
  } catch (err) {
    console.error('Failed to fetch DM messages:', err);
  }
};

/**
 * Get the sole other member's id when the channel has exactly one recipient.
 * Returns null for true groups (3+ members) where pairwise Signal can't be
 * used. Works regardless of `channel.isGroup` — a 2-person channel created
 * via the "Create Group DM" flow is still a 1:1 from a crypto standpoint.
 */
function getDmRecipientUserId(dmChannelId: number): number | null {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  const channel = state.dms.channels.find((c) => c.id === dmChannelId);
  if (!channel) return null;

  const otherMembers = channel.members.filter((m) => m.id !== ownUserId);
  if (otherMembers.length !== 1) return null;
  return otherMembers[0].id;
}

/**
 * In-memory plaintext cache for own sent DM messages.
 * Keyed by ciphertext so we can recover the plaintext when the
 * subscription echo arrives (own messages are encrypted for the recipient,
 * not for ourselves, so we cannot decrypt them via Signal Protocol).
 */
const ownSentPlaintextCache = new Map<string, E2EEPlaintext>();

/**
 * Decrypt an E2EE DM message in-place, replacing content with decrypted plaintext.
 * The server puts the ciphertext in the `content` field for E2EE messages
 * (the `e2ee` flag indicates whether decryption is needed).
 *
 * Generic over the message shape so it can also accept the bare `TDmMessage`
 * that's embedded as `lastMessage` on a DM channel (no `files`/`reactions`).
 */
type TReplyToShape = {
  id: number;
  content: string | null;
  userId: number;
  e2ee?: boolean;
  hasFiles?: boolean;
};

/**
 * Decrypt the inline reply-preview content. Server returns the parent
 * message's ciphertext when e2ee=true, so without this we'd render the
 * raw Signal envelope JSON in the reply preview.
 *
 * - 1:1: pairwise Signal would advance the ratchet on a re-decrypt and
 *   break the parent message's later decrypt. So we ONLY consult the
 *   IDB plaintext cache (populated when the parent was first
 *   decrypted) and fall back to a placeholder on miss.
 * - Group: AES-GCM sender-key decrypt is idempotent — safe to re-run.
 */
async function decryptReplyToInPlace<R extends TReplyToShape>(
  replyTo: R,
  dmChannelId: number,
  isGroup: boolean
): Promise<R> {
  if (!replyTo.e2ee || !replyTo.content) return replyTo;

  const cached = await getCachedPlaintext(replyTo.id);
  if (cached !== undefined) {
    return { ...replyTo, content: cached.content };
  }

  if (isGroup) {
    try {
      const payload = await decryptDmGroupMessage(
        dmChannelId,
        replyTo.userId,
        replyTo.content
      );
      return { ...replyTo, content: payload.content };
    } catch {
      return { ...replyTo, content: '[Unable to decrypt]' };
    }
  }

  return { ...replyTo, content: '[Encrypted message]' };
}

export async function decryptDmMessageInPlace<
  T extends {
    id: number;
    userId: number;
    dmChannelId: number;
    e2ee: boolean;
    content: string | null;
    replyTo?: TReplyToShape | null;
  }
>(message: T): Promise<T> {
  const state = store.getState();
  const channel = state.dms.channels.find((c) => c.id === message.dmChannelId);
  const isGroup = (channel?.members.length ?? 0) > 2;

  // Decrypt the reply-preview ciphertext alongside the main message so
  // the renderer doesn't have to know about e2ee. Done up front because
  // some main-message paths rely on cache hits we may have populated
  // for the parent — looking up the cache is cheap and idempotent.
  const replyTo = message.replyTo
    ? await decryptReplyToInPlace(message.replyTo, message.dmChannelId, isGroup)
    : message.replyTo;

  if (!message.e2ee || !message.content) {
    return replyTo === message.replyTo ? message : { ...message, replyTo };
  }

  // Group DMs use sender-key encryption — both own and other messages
  // are decryptable locally because we have our own sender key cached
  // and peers' keys arrive via distributeSenderKeys. So no
  // ownSentPlaintextCache trickery is needed for groups; it's a
  // single uniform decrypt path.
  if (isGroup) {
    try {
      const payload = await decryptDmGroupMessage(
        message.dmChannelId,
        message.userId,
        message.content
      );
      setFileKeys(message.id, payload.fileKeys);
      return { ...message, content: payload.content, replyTo };
    } catch (err) {
      console.error('[E2EE/DM] Failed to decrypt group DM message:', err);
      return { ...message, content: '[Unable to decrypt]', replyTo };
    }
  }

  // 1:1 path — pairwise Signal Protocol. Own messages are encrypted
  // *to the recipient*, so we cannot self-decrypt; we rely on the
  // ciphertext-keyed plaintext cache populated at send time.
  // Check persistent cache first (works for both own and others' messages).
  // The cached entry stores the ciphertext it came from — when a message
  // is edited the server replaces content with a fresh ciphertext under
  // the same id, and we must re-decrypt the new ciphertext rather than
  // return the stale plaintext.
  const persisted = await getCachedPlaintext(message.id);
  if (persisted !== undefined) {
    const matches =
      persisted.ciphertext === undefined ||
      persisted.ciphertext === message.content;
    if (matches) {
      setFileKeys(message.id, persisted.fileKeys);
      return { ...message, content: persisted.content, replyTo };
    }
    // Stale entry from before an edit — drop it before falling through.
    await deleteCachedPlaintext(message.id).catch(() => {});
  }

  const ownUserId = ownUserIdSelector(state);

  // Own messages are encrypted for the recipient — we cannot decrypt them.
  // Use the in-memory cache populated at send time for the current session.
  if (message.userId === ownUserId) {
    const cached = ownSentPlaintextCache.get(message.content);
    if (cached !== undefined) {
      // AWAIT the persist so the entry survives a refresh that races
      // the subscription echo. Without this, the user can refresh in
      // the ~1ms window after decrypt and lose the plaintext for any
      // own message that hasn't yet been decrypted by the recipient.
      await setCachedPlaintext(message.id, {
        ...cached,
        ciphertext: message.content
      }).catch(() => {});
      setFileKeys(message.id, cached.fileKeys);
      return { ...message, content: cached.content, replyTo };
    }
    return { ...message, content: '[Encrypted message]', replyTo };
  }

  try {
    const payload = await decryptDmMessage(message.userId, message.content);
    // Persist the decrypted plaintext — the ratchet key is now consumed,
    // so a refresh-without-cache would force a libsignal call on a key
    // that no longer exists. Await keeps the IDB write inside the
    // subscription handler's lifetime.
    await setCachedPlaintext(message.id, {
      ...payload,
      ciphertext: message.content
    }).catch(() => {});
    setFileKeys(message.id, payload.fileKeys);
    return { ...message, content: payload.content, replyTo };
  } catch (err) {
    console.error('[E2EE] Failed to decrypt DM message:', err);
    return { ...message, content: '[Unable to decrypt]', replyTo };
  }
}

/**
 * Decrypt an array of E2EE DM messages.
 *
 * Signal Protocol's Double Ratchet requires messages from the *same sender*
 * to be decrypted in order — but messages from different senders are
 * independent ratchet chains and can be decrypted in parallel.
 *
 * We also batch-read the IDB plaintext cache upfront so that cache hits
 * (the common case on page reload) don't each await a separate IDB get.
 */
/**
 * Single source of truth for "decrypt a batch of DM messages for
 * display." Used by every consumer that fetches DM messages from the
 * server: history pagination, the pin banner, the pinned-panel, etc.
 * Wiring new fetchers through this avoids the bug class where a path
 * forgets to decrypt and shows raw Signal envelope JSON.
 */
export async function decryptDmMessages(
  messages: TJoinedDmMessage[]
): Promise<TJoinedDmMessage[]> {
  const e2eeMessages = messages.filter((m) => m.e2ee && m.content);
  if (e2eeMessages.length === 0) return messages;

  // Batch-read IDB cache in a single transaction
  const cachedMap = await getCachedPlaintextBatch(
    e2eeMessages.map((m) => m.id)
  );

  const ownUserId = ownUserIdSelector(store.getState());

  // Group messages by sender to parallelize across senders
  const bySender = new Map<number, { index: number; msg: TJoinedDmMessage }[]>();
  const results = [...messages];
  // Cache writes accumulated across all senders, flushed once at the end so
  // a refresh that interrupts the loop still has every per-message plaintext
  // pinned to its ciphertext on disk.
  const pendingCacheWrites: {
    messageId: number;
    plaintext: CachedDmPlaintext;
  }[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg.e2ee || !msg.content) continue;

    // Resolve cache hits immediately (no decryption needed). Stale entries
    // from before an edit (cached.ciphertext mismatch) fall through to
    // the decrypt path below.
    const cached = cachedMap.get(msg.id);
    if (
      cached !== undefined &&
      (cached.ciphertext === undefined || cached.ciphertext === msg.content)
    ) {
      setFileKeys(msg.id, cached.fileKeys);
      results[i] = { ...msg, content: cached.content };
      continue;
    }

    // Own messages — check in-memory send cache
    if (msg.userId === ownUserId) {
      const sent = ownSentPlaintextCache.get(msg.content);
      if (sent !== undefined) {
        pendingCacheWrites.push({
          messageId: msg.id,
          plaintext: { ...sent, ciphertext: msg.content }
        });
        setFileKeys(msg.id, sent.fileKeys);
        results[i] = { ...msg, content: sent.content };
      } else {
        results[i] = { ...msg, content: '[Encrypted message]' };
      }
      continue;
    }

    // Needs actual decryption — group by sender
    if (!bySender.has(msg.userId)) bySender.set(msg.userId, []);
    bySender.get(msg.userId)!.push({ index: i, msg });
  }

  // Decrypt each sender's chain sequentially, but all senders in parallel
  await Promise.all(
    [...bySender.values()].map(async (chain) => {
      for (const { index, msg } of chain) {
        try {
          const payload = await decryptDmMessage(msg.userId, msg.content!);
          pendingCacheWrites.push({
            messageId: msg.id,
            plaintext: { ...payload, ciphertext: msg.content! }
          });
          setFileKeys(msg.id, payload.fileKeys);
          results[index] = { ...msg, content: payload.content };
        } catch (err) {
          console.error('[E2EE] Failed to decrypt DM message:', err);
          results[index] = { ...msg, content: '[Unable to decrypt]' };
        }
      }
    })
  );

  // Flush all decrypted plaintexts to IDB before returning so a refresh
  // immediately after this call can re-hydrate without re-running the
  // (now-consumed) Signal Protocol decryption.
  if (pendingCacheWrites.length > 0) {
    await setCachedPlaintextBatch(pendingCacheWrites).catch(() => {});
  }

  // Reply-preview decryption pass. The parent of a reply is often in
  // the same batch — its plaintext is in `results` but its IDB cache
  // entry was just written above (and decryptReplyToInPlace's IDB
  // lookup may race the write), so build a local map of decrypted
  // plaintext from this batch and consult it first.
  const localPlaintextById = new Map<number, string>();
  for (const r of results) {
    if (
      r.e2ee &&
      typeof r.content === 'string' &&
      r.content !== '[Encrypted message]' &&
      r.content !== '[Unable to decrypt]'
    ) {
      localPlaintextById.set(r.id, r.content);
    }
  }

  const channelMap = new Map(
    store.getState().dms.channels.map((c) => [c.id, c])
  );

  for (let i = 0; i < results.length; i++) {
    const msg = results[i];
    if (!msg.replyTo?.e2ee || !msg.replyTo.content) continue;

    const local = localPlaintextById.get(msg.replyTo.id);
    if (local !== undefined) {
      results[i] = {
        ...msg,
        replyTo: { ...msg.replyTo, content: local }
      };
      continue;
    }

    const channel = channelMap.get(msg.dmChannelId);
    const isGroup = (channel?.members.length ?? 0) > 2;
    const newReplyTo = await decryptReplyToInPlace(
      msg.replyTo,
      msg.dmChannelId,
      isGroup
    );
    if (newReplyTo !== msg.replyTo) {
      results[i] = { ...msg, replyTo: newReplyTo };
    }
  }

  return results;
}

export const sendDmMessage = async (
  dmChannelId: number,
  content: string,
  files?: string[],
  replyToId?: number,
  fileKeys?: E2EEPlaintext['fileKeys']
) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  const state = store.getState();
  const channel = state.dms.channels.find((c) => c.id === dmChannelId);
  const recipientUserId = getDmRecipientUserId(dmChannelId);

  // Encrypt when E2EE is explicitly enabled on the channel. Errors
  // propagate to the caller (toast) — silently falling back to plaintext
  // would land cleartext in the DB on a conversation the user believes
  // is encrypted, and the server-side e2ee enforcement would reject it
  // anyway. Surface the failure so the user knows.
  if (channel?.e2ee) {
    const plaintext: E2EEPlaintext = { content, fileKeys };
    const ownUserId = ownUserIdSelector(state);
    const isGroup = channel.members.length > 2;

    if (isGroup) {
      if (ownUserId == null) {
        throw new Error('Cannot send encrypted message before login completes');
      }
      // Make sure our sender key has been distributed to every member.
      // Idempotent — covers first send + new joiners since last send.
      const memberIds = channel.members.map((m) => m.id);
      await ensureDmGroupSenderKey(dmChannelId, ownUserId, memberIds);

      const encryptedContent = await encryptDmGroupMessage(
        dmChannelId,
        ownUserId,
        plaintext
      );
      await trpc.dms.sendMessage.mutate({
        dmChannelId,
        content: encryptedContent,
        e2ee: true,
        files,
        replyToId
      });
      return;
    }

    if (!recipientUserId) {
      throw new Error(
        'Cannot send encrypted message: recipient unavailable'
      );
    }
    const encryptedContent = await encryptDmMessage(recipientUserId, plaintext);
    // Cache plaintext so we can display our own message when the
    // subscription echo arrives (own messages can't be self-decrypted
    // in the pairwise scheme).
    ownSentPlaintextCache.set(encryptedContent, plaintext);
    await trpc.dms.sendMessage.mutate({
      dmChannelId,
      content: encryptedContent,
      e2ee: true,
      files,
      replyToId
    });
    return;
  }

  await trpc.dms.sendMessage.mutate({ dmChannelId, content, files, replyToId });
};

export const editDmMessage = async (messageId: number, content: string) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;

  // Check if the original message was E2EE
  const state = store.getState();
  let isE2ee = false;
  let recipientUserId: number | null = null;

  for (const [, messages] of Object.entries(state.dms.messagesMap)) {
    const msg = messages.find((m) => m.id === messageId);
    if (msg) {
      isE2ee = msg.e2ee;
      if (isE2ee) {
        recipientUserId = getDmRecipientUserId(msg.dmChannelId);
      }
      break;
    }
  }

  if (isE2ee && recipientUserId) {
    try {
      const encryptedContent = await encryptDmMessage(recipientUserId, {
        content
      });
      // Cache plaintext so we can display our own edited message when the
      // subscription echo arrives (same as sendDmMessage).
      ownSentPlaintextCache.set(encryptedContent, { content });
      await trpc.dms.editMessage.mutate({ messageId, content: encryptedContent });
      return;
    } catch (err) {
      console.error('[E2EE] Edit encryption failed:', err);
    }
  }

  await trpc.dms.editMessage.mutate({ messageId, content });
};

export const deleteDmMessageAction = async (messageId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.dms.deleteMessage.mutate({ messageId });
};

export const removeDmChannel = (dmChannelId: number) =>
  store.dispatch(dmsSliceActions.removeChannel(dmChannelId));

export const deleteDmChannel = async (dmChannelId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.dms.deleteChannel.mutate({ dmChannelId });
  removeDmChannel(dmChannelId);
};

export const leaveDmChannel = async (dmChannelId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.dms.leave.mutate({ dmChannelId });
  // Server publishes DM_CHANNEL_DELETE to the leaver, but drop the
  // channel synchronously here too so the toast lands on a UI that
  // already reflects the leave (no flicker between toast and the
  // pubsub round-trip).
  removeDmChannel(dmChannelId);
};

export const enableDmEncryption = async (dmChannelId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.dms.enableEncryption.mutate({ dmChannelId });
  // Refresh local state so `channel.e2ee` flips to true immediately.
  // Without this we'd rely on the DM_CHANNEL_UPDATE pubsub round-trip,
  // and any send() before that arrives would go out as plaintext.
  await fetchDmChannels();

  // Group DMs: pre-generate and distribute our sender key so the first
  // send doesn't have to wait for the round-trip. ensureDmGroupSenderKey
  // is idempotent — safe to call before any group send anyway.
  const state = store.getState();
  const channel = state.dms.channels.find((c) => c.id === dmChannelId);
  const ownUserId = ownUserIdSelector(state);
  if (channel && channel.members.length > 2 && ownUserId != null) {
    try {
      await ensureDmGroupSenderKey(
        dmChannelId,
        ownUserId,
        channel.members.map((m) => m.id)
      );
    } catch (err) {
      console.warn('[E2EE/DM] Initial sender-key distribution failed:', err);
      // Non-fatal: ensureDmGroupSenderKey will retry on send.
    }
  }
};

/**
 * On DM_MEMBER_ADD: if the channel is e2ee and we have a sender key,
 * distribute it to the joiner so they can decrypt our future messages.
 * No-op for non-encrypted DMs and for the joiner themselves.
 */
export const syncDmGroupSenderKeysOnMemberAdd = async (
  dmChannelId: number,
  addedUserId: number
) => {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  if (ownUserId == null || addedUserId === ownUserId) return;
  const channel = state.dms.channels.find((c) => c.id === dmChannelId);
  if (!channel?.e2ee) return;
  // Only distribute if the channel is now a real group (≥3 members);
  // 2-person channels use pairwise. Once a 1:1 grows to 3, the user who
  // had encryption on a pairwise basis needs to start a sender-key
  // session — ensureDmGroupSenderKey handles both fresh-generate and
  // distribute-to-missing-members.
  if (channel.members.length < 3) return;
  try {
    await ensureDmGroupSenderKey(
      dmChannelId,
      ownUserId,
      channel.members.map((m) => m.id)
    );
  } catch (err) {
    console.warn(
      '[E2EE/DM] Failed to distribute sender key to new member:',
      err
    );
  }
};

/**
 * On DM_MEMBER_REMOVE: rotate our sender key so the leaver can no longer
 * decrypt future messages with the cached old key (forward secrecy).
 * No-op for non-encrypted DMs, for the case where we are the leaver
 * (we're out of the channel anyway), or when the channel drops below
 * group threshold (back to pairwise).
 */
export const syncDmGroupSenderKeysOnMemberRemove = async (
  dmChannelId: number,
  removedUserId: number
) => {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  if (ownUserId == null || removedUserId === ownUserId) return;
  const channel = state.dms.channels.find((c) => c.id === dmChannelId);
  if (!channel?.e2ee) return;
  if (channel.members.length < 3) return;
  try {
    await rotateDmGroupSenderKey(
      dmChannelId,
      ownUserId,
      channel.members.map((m) => m.id)
    );
  } catch (err) {
    console.warn('[E2EE/DM] Failed to rotate sender key on remove:', err);
  }
};

export const joinDmVoiceCall = async (dmChannelId: number) => {
  const state = store.getState();
  const currentVoiceChannelId = state.server.currentVoiceChannelId;
  const ownDmCallChannelId = state.dms.ownDmCallChannelId;

  // Already in this DM call
  if (ownDmCallChannelId === dmChannelId) return undefined;

  // Leave current voice if in one (server or DM)
  if (currentVoiceChannelId) {
    if (ownDmCallChannelId) {
      await leaveDmVoiceCall();
    } else {
      // Dynamically import to avoid circular dependency with voice/actions
      const { leaveVoice } = await import('../server/voice/actions');
      await leaveVoice();
    }
  }

  const trpc = getHomeTRPCClient();
  if (!trpc) return undefined;
  const result = await trpc.dms.voiceJoin.mutate({
    dmChannelId,
    state: { micMuted: false, soundMuted: false }
  });
  store.dispatch(dmsSliceActions.setOwnDmCallChannelId(dmChannelId));
  // Joining covers an in-flight ring — drop it from the modal.
  store.dispatch(dmsSliceActions.removeRingingCall(dmChannelId));
  // Also set the server voice channel ID so useVoiceEvents subscribes
  setCurrentVoiceChannelId(dmChannelId);
  return result;
};

export const leaveDmVoiceCall = async () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.dms.voiceLeave.mutate();
  store.dispatch(dmsSliceActions.setOwnDmCallChannelId(undefined));
  setCurrentVoiceChannelId(undefined);
  setCurrentVoiceServerId(undefined);
};

export const dmCallStarted = (dmChannelId: number, startedBy: number) => {
  store.dispatch(dmsSliceActions.dmCallStarted({ dmChannelId, startedBy }));

  // Decide whether this user should hear the ring. Skip if:
  //  - we're the caller (the publish goes to all members, including
  //    self, so the originator doesn't ring themselves)
  //  - we're already in this exact call (e.g. accepted from another
  //    tab / rejoin after a brief disconnect)
  const state = store.getState();
  const ownUserId = state.server.ownUserId;
  const ownDmCallChannelId = state.dms.ownDmCallChannelId;
  if (ownUserId == null || startedBy === ownUserId) return;
  if (ownDmCallChannelId === dmChannelId) return;

  store.dispatch(dmsSliceActions.addRingingCall(dmChannelId));
};

export const dmCallEnded = (dmChannelId: number) => {
  store.dispatch(dmsSliceActions.dmCallEnded({ dmChannelId }));
  // Auto-dismiss any incoming-call modal for this channel — the call
  // is over, no point ringing for it.
  store.dispatch(dmsSliceActions.removeRingingCall(dmChannelId));
};

export const dismissRingingCall = (dmChannelId: number) =>
  store.dispatch(dmsSliceActions.removeRingingCall(dmChannelId));

/**
 * Clear an unread badge on a DM the user is actively looking at —
 * both locally and server-side. Defensive against races where
 * isViewingThisChannel is false in addDmMessages but the user is
 * really on the channel (state propagation lag, tab focus quirks,
 * etc): the consumer (DmConversation) calls this on every render
 * where unreadCount > 0, so the badge can never linger.
 */
export const clearDmChannelUnread = (dmChannelId: number) => {
  store.dispatch(dmsSliceActions.clearChannelUnread(dmChannelId));
  markDmChannelAsRead(dmChannelId);
};

/**
 * Handle a peer declining a call we may be in. Two side effects:
 *  - Toast "<Name> declined" so the user gets immediate feedback.
 *  - For 1:1 DMs (members.length === 2), auto-leave the call —
 *    the only possible joiner just said no, no point waiting for
 *    the 30s solo-leave timeout. For groups, just toast; other
 *    members may still answer.
 *
 * Skips the toast for own decline events (the publish goes to all
 * members including the decliner, so we'd otherwise toast ourselves).
 */
export const dmCallDeclined = (
  dmChannelId: number,
  declinedByUserId: number
) => {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  if (declinedByUserId === ownUserId) return;

  const channel = state.dms.channels.find((c) => c.id === dmChannelId);
  const decliner = channel?.members.find((m) => m.id === declinedByUserId);
  const name = decliner?.name ?? 'A user';
  toast.info(`${name} declined`);

  // Auto-leave if this is the call we're in and there's no point
  // staying — i.e. effectively-1:1 (member count of 2).
  const ownInCall = state.dms.ownDmCallChannelId === dmChannelId;
  const isOneOnOne = (channel?.members.length ?? 0) === 2;
  if (ownInCall && isOneOnOne) {
    leaveDmVoiceCall().catch(() => {
      // Best-effort — toast already informed the user.
    });
  }
};

export const dmCallUserJoined = (
  dmChannelId: number,
  userId: number,
  state: import('@pulse/shared').TVoiceUserState
) =>
  store.dispatch(
    dmsSliceActions.dmCallUserJoined({ dmChannelId, userId, state })
  );

export const dmCallUserLeft = (dmChannelId: number, userId: number) =>
  store.dispatch(dmsSliceActions.dmCallUserLeft({ dmChannelId, userId }));

// Typing indicators

const dmTypingTimeouts: Record<string, ReturnType<typeof setTimeout>> = {};

const getDmTypingKey = (dmChannelId: number, userId: number) =>
  `${dmChannelId}:${userId}`;

export const addDmTypingUser = (dmChannelId: number, userId: number) => {
  store.dispatch(dmsSliceActions.addDmTypingUser({ dmChannelId, userId }));

  const key = getDmTypingKey(dmChannelId, userId);

  if (dmTypingTimeouts[key]) {
    clearTimeout(dmTypingTimeouts[key]);
  }

  dmTypingTimeouts[key] = setTimeout(() => {
    removeDmTypingUser(dmChannelId, userId);
    delete dmTypingTimeouts[key];
  }, TYPING_MS + 500);
};

export const removeDmTypingUser = (dmChannelId: number, userId: number) => {
  store.dispatch(dmsSliceActions.removeDmTypingUser({ dmChannelId, userId }));
};
