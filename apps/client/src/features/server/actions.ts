import {
  fetchJoinedServers,
  fetchServerUnreadCounts,
  getSavedActiveServerId,
  getSavedActiveView,
  setActiveInstanceDomain,
  setActiveServerId,
  setActiveView,
  switchToFederatedServer
} from '@/features/app/actions';
import { appSliceActions } from '@/features/app/slice';
import { fetchActiveDmCalls, fetchDmChannels } from '@/features/dms/actions';
import {
  fetchBlockedUsers,
  fetchFriendRequests,
  fetchFriends
} from '@/features/friends/actions';
import { fetchNameplates } from '@/features/nameplates/actions';
import { logDebug } from '@/helpers/browser-logger';
import { getHostFromServer } from '@/helpers/get-file-url';
import { applyServerPreferences } from '@/lib/preferences-apply';
import { seedPreferencesFromLocalStorage } from '@/lib/preferences-seed';
import { cleanup, connectToTRPC, getHomeTRPCClient } from '@/lib/trpc';
import type { TPublicServerSettings, TServerInfo } from '@pulse/server/types';
import { store } from '../store';
import { setPluginCommands } from './plugins/actions';
import { infoSelector } from './selectors';
import { serverSliceActions } from './slice';
import {
  initSubscriptions,
  subscribeToHome,
  subscribeToVoice
} from './subscriptions';
import { type TDisconnectInfo } from './types';
import { emitAppEvent } from '@/lib/events';

let unsubscribeFromServer: (() => void) | null = null;
let unsubscribeFromHome: (() => void) | null = null;
let unsubscribeFromVoice: (() => void) | null = null;
let currentHandshakeHash: string | null = null;

/**
 * Generation counter for server joins. Every join (home or federated)
 * takes a token before its request goes out and applies the response
 * only if no later join has started since — rapid A→B clicks otherwise
 * landed on whichever response arrived last, with the other server
 * highlighted.
 */
let joinGeneration = 0;

export const beginServerJoin = () => ++joinGeneration;

export const isCurrentServerJoin = (token: number) =>
  token === joinGeneration;

export const setConnected = (status: boolean) => {
  store.dispatch(serverSliceActions.setConnected(status));
};

export const resetServerState = () => {
  store.dispatch(serverSliceActions.resetState());
};

export const setDisconnectInfo = (info: TDisconnectInfo | undefined) => {
  store.dispatch(serverSliceActions.setDisconnectInfo(info));
};


export const setReconnecting = (status: boolean) => {
  store.dispatch(serverSliceActions.setReconnecting(status));
};

export const setReconnectAttempt = (attempt: number) => {
  store.dispatch(serverSliceActions.setReconnectAttempt(attempt));
};


export const setPublicServerSettings = (
  settings: TPublicServerSettings | undefined
) => {
  store.dispatch(serverSliceActions.setPublicSettings(settings));
};

export const setInfo = (info: TServerInfo | undefined) => {
  store.dispatch(serverSliceActions.setInfo(info));
};

export const connect = async () => {
  const state = store.getState();
  const info = infoSelector(state);

  if (!info) {
    throw new Error('Failed to fetch server info');
  }

  // What the user was looking at before the socket dropped. A reconnect
  // rejoins the HOME server first (that is what the home socket serves);
  // a federated server in focus is re-entered afterwards so the slice,
  // the routing domain and the subscriptions describe the same instance
  // again. Left as it was, the slice held home data while every ambient
  // call still went to the remote with home numeric ids.
  const { activeInstanceDomain, activeServerId } = state.app;

  const host = getHostFromServer();
  const trpc = connectToTRPC(host);

  const { handshakeHash } = await trpc.others.handshake.query();

  currentHandshakeHash = handshakeHash;

  if (activeInstanceDomain) {
    setActiveInstanceDomain(null);
  }

  // Restore last active server from localStorage
  const savedServerId = getSavedActiveServerId();
  await joinServer(handshakeHash, savedServerId);

  // Home-scoped subscriptions live for the whole home connection: one
  // set per socket, never per server switch (a re-subscribe round trip
  // on every switch dropped DM messages, calls and friend events that
  // arrived in the gap). They must follow the first join: the server
  // only treats the socket as authenticated once joinServer has run,
  // and a subscription opened before that is refused as UNAUTHORIZED
  // and never retried.
  unsubscribeFromHome?.();
  unsubscribeFromHome = subscribeToHome();

  if (activeInstanceDomain && activeServerId !== undefined) {
    await switchToFederatedServer(activeInstanceDomain, activeServerId);
  }
};

/**
 * Fire deferred data fetches after the bootstrap data has been dispatched.
 * Guards against stale responses when switching servers quickly.
 */
export const fetchDeferredServerData = (
  trpc: ReturnType<typeof getHomeTRPCClient>,
  expectedServerId: string
) => {
  if (!trpc) return;
  const isStale = () => store.getState().server.serverId !== expectedServerId;

  trpc.others.getServerMembers.query().then((users) => {
    if (isStale()) return;
    store.dispatch(serverSliceActions.setUsers(users));
    store.dispatch(serverSliceActions.setUsersLoaded(true));
  }).catch((err) => console.error('Failed to fetch server members:', err));

  trpc.others.getServerEmojis.query().then((emojis) => {
    if (isStale()) return;
    store.dispatch(serverSliceActions.setEmojis(emojis));
    store.dispatch(serverSliceActions.setEmojisLoaded(true));
  }).catch((err) => console.error('Failed to fetch server emojis:', err));

  trpc.others.getServerVoiceState.query().then((voiceState) => {
    if (isStale()) return;
    store.dispatch(serverSliceActions.setDeferredVoiceState(voiceState));
  }).catch((err) => console.error('Failed to fetch voice state:', err));

  fetchNameplates(trpc, expectedServerId);
};

export const joinServer = async (
  handshakeHash: string,
  serverId?: number
) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  const join = beginServerJoin();
  const data = await trpc.others.joinServer.query({
    handshakeHash,
    serverId
  });

  // A later join (home or federated) started while this one was in
  // flight: its response is the one the user asked for, drop this one.
  if (!isCurrentServerJoin(join)) return;

  logDebug('joinServer', data);

  // Unsubscribe from previous server if switching
  unsubscribeFromServer?.();
  unsubscribeFromServer = initSubscriptions();

  // Re-subscribe voice (always re-create after reconnect or first connect)
  unsubscribeFromVoice?.();
  unsubscribeFromVoice = subscribeToVoice();

  // Apply server preferences to localStorage BEFORE setInitialData
  // so the server-channel-map is available when the reducer reads it
  if (data.userPreferences) {
    applyServerPreferences(data.userPreferences);
  }

  store.dispatch(serverSliceActions.setInitialData(data));

  // This is the HOME join path (getHomeTRPCClient above) — record the
  // home identity separately. state.server.ownUserId is overwritten
  // with the remote shadow id when viewing a federated server, and
  // home-scoped comparisons (friend requests, DMs) must not use it.
  store.dispatch(appSliceActions.setHomeOwnUserId(data.ownUserId));

  // After state is initialized, handle preference sync
  if (data.userPreferences) {
    emitAppEvent('preferences-loaded');
  } else {
    seedPreferencesFromLocalStorage();
  }

  // Track the active server's DB id
  if (data.serverDbId) {
    setActiveServerId(data.serverDbId);
  }

  setPluginCommands(data.commands);

  // Fetch deferred data (members, emojis, voice state) in parallel
  fetchDeferredServerData(trpc, data.serverId);

  // Fetch friends, DM data, joined servers, and unread counts in parallel
  fetchFriends();
  fetchFriendRequests();
  fetchBlockedUsers();
  fetchDmChannels();
  fetchActiveDmCalls();
  fetchServerUnreadCounts();

  const servers = await fetchJoinedServers();

  // Restore the last active view, falling back to server/discover based on membership
  const savedView = getSavedActiveView();
  if (savedView && (savedView !== 'server' || servers.length > 0)) {
    setActiveView(savedView);
  } else if (servers.length > 0) {
    setActiveView('server');
  } else {
    setActiveView('discover');
  }
};

export const reinitServerSubscriptions = () => {
  unsubscribeFromServer?.();
  unsubscribeFromServer = initSubscriptions();

  // Re-subscribe voice so events come from the active instance
  unsubscribeFromVoice?.();
  unsubscribeFromVoice = subscribeToVoice();
};

export const getHandshakeHash = () => currentHandshakeHash;

export const disconnectFromServer = () => {
  // cleanup(true) also wipes every E2EE store (home and per-instance),
  // so the next user on this browser inherits no keys.
  cleanup(true);
  unsubscribeFromServer?.();
  unsubscribeFromServer = null;
  unsubscribeFromHome?.();
  unsubscribeFromHome = null;
  unsubscribeFromVoice?.();
  unsubscribeFromVoice = null;
  currentHandshakeHash = null;
};
