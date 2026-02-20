import { encryptDmMessage, decryptDmMessage } from '@/lib/e2ee';
import { sendDesktopNotification } from '@/features/notifications/desktop-notification';
import { getHomeTRPCClient } from '@/lib/trpc';
import { TYPING_MS, type TJoinedDmChannel, type TJoinedDmMessage } from '@pulse/shared';
import { setCurrentVoiceChannelId, setCurrentVoiceServerId } from '../server/channels/actions';
import { playSound } from '../server/sounds/actions';
import { SoundType } from '../server/types';
import { ownUserIdSelector } from '../server/users/selectors';
import { addUserToVoiceChannel } from '../server/voice/actions';
import { store } from '../store';
import { dmsSliceActions } from './slice';
import {
  getCachedPlaintext,
  setCachedPlaintext
} from './plaintext-cache';

export const setDmChannels = (channels: TJoinedDmChannel[]) =>
  store.dispatch(dmsSliceActions.setChannels(channels));

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
    if (messages[0].userId !== ownUserId) {
      playSound(SoundType.MESSAGE_RECEIVED);
      sendDesktopNotification(
        'New Direct Message',
        messages[0].content?.slice(0, 100) || 'New message received'
      );

      // Increment unread count if this channel is not currently selected
      const selectedId = state.dms.selectedChannelId;
      if (selectedId !== dmChannelId) {
        store.dispatch(dmsSliceActions.incrementChannelUnread(dmChannelId));
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

export const fetchDmChannels = async () => {
  const trpc = getHomeTRPCClient();
  setDmsLoading(true);
  try {
    const channels = await trpc.dms.getChannels.query();
    setDmChannels(channels);
  } catch (err) {
    console.error('Failed to fetch DM channels:', err);
  } finally {
    setDmsLoading(false);
  }
};

export const fetchActiveDmCalls = async () => {
  const trpc = getHomeTRPCClient();
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
  try {
    const channel = await trpc.dms.getOrCreateChannel.mutate({ userId });
    addOrUpdateDmChannel(channel);
    return channel;
  } catch (err) {
    console.error('Failed to get or create DM channel:', err);
  }
};

export const fetchDmMessages = async (
  dmChannelId: number,
  cursor?: number | null
) => {
  const trpc = getHomeTRPCClient();
  try {
    const result = await trpc.dms.getMessages.query({ dmChannelId, cursor });

    // Decrypt any E2EE messages
    const decryptedMessages = await decryptDmMessages(result.messages);
    addDmMessages(dmChannelId, decryptedMessages, { prepend: !!cursor });

    // Clear unread badge when fetching the first page (user opened the channel)
    if (!cursor) {
      store.dispatch(dmsSliceActions.clearChannelUnread(dmChannelId));
    }

    return result.nextCursor;
  } catch (err) {
    console.error('Failed to fetch DM messages:', err);
  }
};

/**
 * Get the other user's ID in a 1-on-1 DM channel.
 */
function getDmRecipientUserId(dmChannelId: number): number | null {
  const state = store.getState();
  const ownUserId = ownUserIdSelector(state);
  const channel = state.dms.channels.find((c) => c.id === dmChannelId);
  if (!channel || channel.isGroup) return null;

  const otherMember = channel.members.find((m) => m.id !== ownUserId);
  return otherMember?.id ?? null;
}

/**
 * In-memory plaintext cache for own sent DM messages.
 * Keyed by encryptedContent so we can recover the plaintext when the
 * subscription echo arrives (own messages are encrypted for the recipient,
 * not for ourselves, so we cannot decrypt them via Signal Protocol).
 */
const ownSentPlaintextCache = new Map<string, string>();

/**
 * Decrypt an E2EE DM message in-place, replacing encryptedContent with decrypted content.
 * Uses a persistent IDB cache so that messages survive page refreshes
 * (Signal Protocol consumes message keys on decryption — ciphertexts can
 * only be decrypted once via the ratchet).
 */
export async function decryptDmMessageInPlace(
  message: TJoinedDmMessage
): Promise<TJoinedDmMessage> {
  if (!message.e2ee || !message.encryptedContent) return message;

  // Check persistent cache first (works for both own and others' messages)
  const persisted = await getCachedPlaintext(message.id);
  if (persisted !== undefined) {
    return { ...message, content: persisted };
  }

  const ownUserId = ownUserIdSelector(store.getState());

  // Own messages are encrypted for the recipient — we cannot decrypt them.
  // Use the in-memory cache populated at send time for the current session.
  if (message.userId === ownUserId) {
    const cached = ownSentPlaintextCache.get(message.encryptedContent);
    if (cached !== undefined) {
      // Persist so it survives page refresh
      setCachedPlaintext(message.id, cached).catch(() => {});
      return { ...message, content: cached };
    }
    return { ...message, content: '[Encrypted message]' };
  }

  try {
    const payload = await decryptDmMessage(message.userId, message.encryptedContent);
    // Persist the decrypted plaintext — the ratchet key is now consumed
    setCachedPlaintext(message.id, payload.content).catch(() => {});
    return { ...message, content: payload.content };
  } catch (err) {
    console.error('[E2EE] Failed to decrypt DM message:', err);
    return { ...message, content: '[Unable to decrypt]' };
  }
}

/**
 * Decrypt an array of E2EE DM messages.
 * Must be sequential — Signal Protocol's Double Ratchet requires messages
 * from the same sender to be decrypted in order (the first PreKeyWhisperMessage
 * establishes the session that subsequent WhisperMessages depend on).
 */
async function decryptDmMessages(
  messages: TJoinedDmMessage[]
): Promise<TJoinedDmMessage[]> {
  const results: TJoinedDmMessage[] = [];
  for (const msg of messages) {
    results.push(await decryptDmMessageInPlace(msg));
  }
  return results;
}

export const sendDmMessage = async (
  dmChannelId: number,
  content: string,
  files?: string[],
  replyToId?: number
) => {
  const trpc = getHomeTRPCClient();
  const recipientUserId = getDmRecipientUserId(dmChannelId);

  // For 1-on-1 DMs, encrypt the message
  if (recipientUserId) {
    try {
      const encryptedContent = await encryptDmMessage(recipientUserId, {
        content
      });
      // Cache plaintext so we can display our own message when the
      // subscription echo arrives (own messages can't be self-decrypted).
      ownSentPlaintextCache.set(encryptedContent, content);
      await trpc.dms.sendMessage.mutate({
        dmChannelId,
        encryptedContent,
        e2ee: true,
        files,
        replyToId
      });
      return;
    } catch (err) {
      console.error('[E2EE] Encryption failed, sending plaintext:', err);
      // Fall through to plaintext if encryption fails
    }
  }

  await trpc.dms.sendMessage.mutate({ dmChannelId, content, files, replyToId });
};

export const editDmMessage = async (messageId: number, content: string) => {
  const trpc = getHomeTRPCClient();

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
      ownSentPlaintextCache.set(encryptedContent, content);
      await trpc.dms.editMessage.mutate({ messageId, encryptedContent });
      return;
    } catch (err) {
      console.error('[E2EE] Edit encryption failed:', err);
    }
  }

  await trpc.dms.editMessage.mutate({ messageId, content });
};

export const deleteDmMessageAction = async (messageId: number) => {
  const trpc = getHomeTRPCClient();
  await trpc.dms.deleteMessage.mutate({ messageId });
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
  const result = await trpc.dms.voiceJoin.mutate({
    dmChannelId,
    state: { micMuted: false, soundMuted: false }
  });
  store.dispatch(dmsSliceActions.setOwnDmCallChannelId(dmChannelId));
  // Also set the server voice channel ID so useVoiceEvents subscribes
  setCurrentVoiceChannelId(dmChannelId);
  return result;
};

export const leaveDmVoiceCall = async () => {
  const trpc = getHomeTRPCClient();
  await trpc.dms.voiceLeave.mutate();
  store.dispatch(dmsSliceActions.setOwnDmCallChannelId(undefined));
  setCurrentVoiceChannelId(undefined);
  setCurrentVoiceServerId(undefined);
};

export const dmCallStarted = (dmChannelId: number, startedBy: number) =>
  store.dispatch(dmsSliceActions.dmCallStarted({ dmChannelId, startedBy }));

export const dmCallEnded = (dmChannelId: number) =>
  store.dispatch(dmsSliceActions.dmCallEnded({ dmChannelId }));

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
