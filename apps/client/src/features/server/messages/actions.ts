import { sendDesktopNotification } from '@/features/notifications/desktop-notification';
import { store } from '@/features/store';
import { getTRPCClient } from '@/lib/trpc';
import { TYPING_MS } from '@pulse/shared';
import type { TJoinedMessage, TJoinedPublicUser } from '@pulse/server/types';
import { activeThreadIdSelector, selectedChannelIdSelector } from '../channels/selectors';
import { serverSliceActions } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';

const typingTimeouts: { [key: string]: NodeJS.Timeout } = {};

const getTypingKey = (channelId: number, userId: number) =>
  `${channelId}-${userId}`;

/**
 * Merge the `authors` array a preview messages.get response carries into
 * the users map — previewers get no member bootstrap, so this is the only
 * way names/avatars resolve. addUser dedupes by id; no-op for the normal
 * member path (authors undefined).
 */
export const mergeMessageAuthors = (authors?: TJoinedPublicUser[]) => {
  if (!authors?.length) return;

  for (const author of authors) {
    store.dispatch(serverSliceActions.addUser(author));
  }
};

export const addMessages = (
  channelId: number,
  messages: TJoinedMessage[],
  opts: { prepend?: boolean } = {},
  isSubscriptionMessage = false
) => {
  const state = store.getState();
  const selectedChannelId = selectedChannelIdSelector(state);
  const activeThreadId = activeThreadIdSelector(state);
  // A window detached from the live tail (jump / paged past the cap)
  // does not take live messages — see features/message-window.ts.
  const detached = !!state.server.messageWindowMap[channelId]?.hasNewer;

  store.dispatch(
    serverSliceActions.addMessages({
      channelId,
      messages,
      opts: { ...opts, live: isSubscriptionMessage }
    })
  );

  messages.forEach((message) => {
    removeTypingUser(channelId, message.userId);
  });

  if (isSubscriptionMessage && messages.length > 0) {
    const state = store.getState();
    const ownUserId = ownUserIdSelector(state);
    const targetMessage = messages[0];
    const isFromOwnUser = ownUserId != null && ownUserId === targetMessage.userId;

    // selectedChannelId / activeThreadId are sticky per-server state
    // (kept so re-entering the server lands you in the same place).
    // To decide whether the user is *currently looking at* this channel,
    // also require activeView==='server' AND the message's server matches
    // activeServerId — otherwise navigating to home or a different server
    // would silently suppress notifications for the channel you left.
    const channel = state.server.channels.find((c) => c.id === channelId);
    const isViewingChannel =
      state.app.activeView === 'server' &&
      channel?.serverId === state.app.activeServerId &&
      (channelId === selectedChannelId || channelId === activeThreadId);

    if (!isFromOwnUser && ownUserId != null && !isViewingChannel) {
      playSound(SoundType.MESSAGE_RECEIVED);
      const sender = state.server.users.find(
        (u) => u.id === targetMessage.userId
      );
      const senderName = sender?.name || 'Someone';

      let title: string;
      if (channel?.type === 'THREAD' && channel.parentChannelId) {
        const parentChannel = state.server.channels.find(
          (c) => c.id === channel.parentChannelId
        );
        if (parentChannel?.type === 'FORUM') {
          title = `${senderName} in #${parentChannel.name} › ${channel.name}`;
        } else {
          title = `${senderName} in #${parentChannel?.name ?? 'thread'} › ${channel.name}`;
        }
      } else if (channel) {
        title = `${senderName} in #${channel.name}`;
      } else {
        title = senderName;
      }

      sendDesktopNotification(
        title,
        targetMessage.content?.slice(0, 100) || 'New message received'
      );
    }

    // Viewing the channel marks the message read — unless the window is
    // detached: the message is not on screen then (it sits beyond the
    // loaded history) and is only seen after "Jump to Present".
    if (isViewingChannel && !isFromOwnUser && !detached) {
      const trpc = getTRPCClient();
      if (!trpc) return;

      try {
        trpc.channels.markAsRead.mutate({ channelId });
      } catch {
        // ignore errors
      }
    }
  }
};

export const updateMessage = (channelId: number, message: TJoinedMessage) => {
  store.dispatch(serverSliceActions.updateMessage({ channelId, message }));
};

export const deleteMessage = (channelId: number, messageId: number) => {
  store.dispatch(serverSliceActions.deleteMessage({ channelId, messageId }));
};

export const bulkDeleteMessages = (
  channelId: number,
  messageIds: number[]
) => {
  store.dispatch(
    serverSliceActions.bulkDeleteMessages({ channelId, messageIds })
  );
};

export const purgeChannelMessages = (channelId: number) => {
  store.dispatch(serverSliceActions.purgeChannelMessages({ channelId }));
};

/** A freshly fetched latest page re-attaches the channel to the tail. */
export const replaceMessages = (
  channelId: number,
  messages: TJoinedMessage[],
  hasOlder: boolean
) => {
  store.dispatch(
    serverSliceActions.replaceMessages({ channelId, messages, hasOlder })
  );
};

export const setMessageWindow = (
  channelId: number,
  window: { hasOlder?: boolean; hasNewer?: boolean }
) => {
  store.dispatch(serverSliceActions.setMessageWindow({ channelId, ...window }));
};

export const addTypingUser = (channelId: number, userId: number) => {
  store.dispatch(serverSliceActions.addTypingUser({ channelId, userId }));

  const timeoutKey = getTypingKey(channelId, userId);

  if (typingTimeouts[timeoutKey]) {
    clearTimeout(typingTimeouts[timeoutKey]);
  }

  typingTimeouts[timeoutKey] = setTimeout(() => {
    removeTypingUser(channelId, userId);
    delete typingTimeouts[timeoutKey];
  }, TYPING_MS + 500);
};

export const removeTypingUser = (channelId: number, userId: number) => {
  store.dispatch(serverSliceActions.removeTypingUser({ channelId, userId }));
};
