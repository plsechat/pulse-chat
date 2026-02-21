import { store } from '@/features/store';
import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { getTRPCClient } from '@/lib/trpc';
import type { TChannel, TChannelUserPermissionsMap } from '@pulse/shared';
import { serverSliceActions } from '../slice';
import { channelByIdSelector, channelReadStateByIdSelector, selectedChannelIdSelector } from './selectors';

export const setChannels = (channels: TChannel[]) => {
  store.dispatch(serverSliceActions.setChannels(channels));
};

/** Get the saved channel-per-server map from localStorage. */
export const getServerChannelMap = (): Record<string, number> =>
  getLocalStorageItemAsJSON<Record<string, number>>(
    LocalStorageKey.SERVER_CHANNEL_MAP,
    {}
  ) ?? {};

/** Save the current channel selection for the active server. */
const persistChannelForServer = (channelId: number) => {
  const state = store.getState();
  const serverId = state.server.serverId;
  if (!serverId) return;

  const map = getServerChannelMap();
  map[serverId] = channelId;
  setLocalStorageItemAsJSON(LocalStorageKey.SERVER_CHANNEL_MAP, map);
};

export const setSelectedChannelId = (channelId: number | undefined) => {
  if (channelId !== undefined) {
    const state = store.getState();
    const unreadCount = channelReadStateByIdSelector(state, channelId);
    if (unreadCount > 0) {
      const trpc = getTRPCClient();
      trpc.channels.markAsRead.mutate({ channelId }).catch(() => {});
    }
    persistChannelForServer(channelId);
  }
  store.dispatch(serverSliceActions.setSelectedChannelId(channelId));
};

export const setCurrentVoiceChannelId = (channelId: number | undefined) =>
  store.dispatch(serverSliceActions.setCurrentVoiceChannelId(channelId));

export const setCurrentVoiceServerId = (serverId: number | undefined) =>
  store.dispatch(serverSliceActions.setCurrentVoiceServerId(serverId));

export const addChannel = (channel: TChannel) => {
  store.dispatch(serverSliceActions.addChannel(channel));
};

export const updateChannel = (
  channelId: number,
  channel: Partial<TChannel>
) => {
  store.dispatch(serverSliceActions.updateChannel({ channelId, channel }));
};

export const removeChannel = (channelId: number) => {
  store.dispatch(serverSliceActions.removeChannel({ channelId }));
};

export const setChannelPermissions = (
  permissions: TChannelUserPermissionsMap
) => {
  store.dispatch(serverSliceActions.setChannelPermissions(permissions));

  const state = store.getState();
  const selectedChannel = selectedChannelIdSelector(state);

  if (!selectedChannel) return;

  const channel = channelByIdSelector(state, selectedChannel || -1);

  if (!channel?.private) return;

  // user is in a channel that is private, so we need to check if their permissions changed
  const canViewChannel =
    permissions[selectedChannel]?.permissions['VIEW_CHANNEL'] === true;

  if (!canViewChannel) {
    // user lost VIEW_CHANNEL permission, deselect the channel
    setSelectedChannelId(undefined);
  }
};

export const setActiveThreadId = (threadId: number | undefined) => {
  store.dispatch(serverSliceActions.setActiveThreadId(threadId));
};

export const setHighlightedMessageId = (messageId: number | undefined) => {
  store.dispatch(serverSliceActions.setHighlightedMessageId(messageId));
};

export const setChannelReadState = (
  channelId: number,
  count: number | undefined
) => {
  const state = store.getState();
  const selectedChannel = selectedChannelIdSelector(state);

  let actualCount = count;

  // if the channel is currently selected, set the read count to 0
  if (selectedChannel === channelId) {
    actualCount = 0;

    // we also need to notify the server that the channel has been read
    // otherwise the count will be wrong when the user joins the server again
    // we can't do it here to avoid infinite loops
  }

  store.dispatch(
    serverSliceActions.setChannelReadState({ channelId, count: actualCount })
  );
};

export const setChannelMentionState = (
  channelId: number,
  count: number | undefined
) => {
  const state = store.getState();
  const selectedChannel = selectedChannelIdSelector(state);

  let actualCount = count;

  if (selectedChannel === channelId) {
    actualCount = 0;
  }

  store.dispatch(
    serverSliceActions.setChannelMentionState({ channelId, count: actualCount })
  );
};
