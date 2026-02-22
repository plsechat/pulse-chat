import { sendDesktopNotification } from '@/features/notifications/desktop-notification';
import { store } from '@/features/store';
import { getTRPCClient } from '@/lib/trpc';
import { TYPING_MS, type TJoinedMessage } from '@pulse/shared';
import { selectedChannelIdSelector } from '../channels/selectors';
import { serverSliceActions } from '../slice';
import { playSound } from '../sounds/actions';
import { SoundType } from '../types';
import { ownUserIdSelector } from '../users/selectors';

const typingTimeouts: { [key: string]: NodeJS.Timeout } = {};

const getTypingKey = (channelId: number, userId: number) =>
  `${channelId}-${userId}`;

export const addMessages = (
  channelId: number,
  messages: TJoinedMessage[],
  opts: { prepend?: boolean } = {},
  isSubscriptionMessage = false
) => {
  const state = store.getState();
  const selectedChannelId = selectedChannelIdSelector(state);

  store.dispatch(serverSliceActions.addMessages({ channelId, messages, opts }));

  messages.forEach((message) => {
    removeTypingUser(channelId, message.userId);
  });

  if (isSubscriptionMessage && messages.length > 0) {
    const state = store.getState();
    const ownUserId = ownUserIdSelector(state);
    const targetMessage = messages[0];
    const isFromOwnUser = ownUserId === targetMessage.userId;

    if (!isFromOwnUser) {
      playSound(SoundType.MESSAGE_RECEIVED);
      const sender = state.server.users.find(
        (u) => u.id === targetMessage.userId
      );
      sendDesktopNotification(
        sender?.name || 'New Message',
        targetMessage.content?.slice(0, 100) || 'New message received'
      );
    }

    if (channelId === selectedChannelId && !isFromOwnUser) {
      // user is viewing this channel - mark messages as read
      const trpc = getTRPCClient();

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
