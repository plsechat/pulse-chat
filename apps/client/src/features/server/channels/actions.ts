import { store } from '@/features/store';
import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { syncPreference } from '@/lib/preferences-sync';
import { getTRPCClient } from '@/lib/trpc';
import { ChannelType, type TChannel, type TChannelUserPermissionsMap } from '@pulse/shared';
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
  syncPreference({ serverChannelMap: { [serverId]: channelId } });
};

export const setSelectedChannelId = (channelId: number | undefined) => {
  if (channelId !== undefined) {
    const state = store.getState();
    const unreadCount = channelReadStateByIdSelector(state, channelId);
    if (unreadCount > 0) {
      const trpc = getTRPCClient();
      if (trpc) {
        trpc.channels.markAsRead.mutate({ channelId }).catch(() => {});
      }
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

/**
 * True only when the user is *currently looking at* this channel.
 * selectedChannelId is sticky per-server state (kept so re-entering the
 * server lands you in the same place), so it alone must never be used
 * to suppress badges: while the user is on Home or another server, the
 * stale selection zeroed incoming counts — the badge then lied at 0 and
 * the markAsRead gate (`unreadCount > 0`) skipped the real clear on
 * return. Mirrors the gate in messages/actions.ts.
 */
const isViewingChannel = (
  state: ReturnType<typeof store.getState>,
  channelId: number
) => {
  if (selectedChannelIdSelector(state) !== channelId) return false;
  const channel = state.server.channels.find((c) => c.id === channelId);
  return (
    state.app.activeView === 'server' &&
    channel?.serverId === state.app.activeServerId
  );
};

export const setChannelReadState = (
  channelId: number,
  count: number | undefined
) => {
  const state = store.getState();

  let actualCount = count;

  // Suppress the badge when the user is actively viewing the channel —
  // EXCEPT for forums. A forum's "selected" state means the user is on
  // the post-list view; messages arrive in *thread children*, and the
  // forum's aggregated unread is what surfaces "this thread has new
  // posts". Suppressing it here was the cause of the QA report:
  // posts to threads showed no badge while the forum was open, only
  // appearing after navigating away and back.
  if (isViewingChannel(state, channelId)) {
    const channel = state.server.channels.find((c) => c.id === channelId);
    if (channel?.type !== ChannelType.FORUM) {
      actualCount = 0;
    }
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

  let actualCount = count;

  if (isViewingChannel(state, channelId)) {
    const channel = state.server.channels.find((c) => c.id === channelId);
    if (channel?.type !== ChannelType.FORUM) {
      actualCount = 0;
    }
  }

  store.dispatch(
    serverSliceActions.setChannelMentionState({ channelId, count: actualCount })
  );
};
