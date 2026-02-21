import { Dialog } from '@/components/dialogs/dialogs';
import {
  fetchJoinedServers,
  fetchServerUnreadCounts,
  getSavedActiveServerId,
  getSavedActiveView,
  setActiveServerId,
  setActiveView
} from '@/features/app/actions';
import { fetchActiveDmCalls, fetchDmChannels } from '@/features/dms/actions';
import { fetchFriendRequests, fetchFriends } from '@/features/friends/actions';
import { logDebug } from '@/helpers/browser-logger';
import { getHostFromServer } from '@/helpers/get-file-url';
import { cleanup, connectToTRPC, getHomeTRPCClient } from '@/lib/trpc';
import { type TPublicServerSettings, type TServerInfo } from '@pulse/shared';
import { openDialog } from '../dialogs/actions';
import { store } from '../store';
import { setPluginCommands } from './plugins/actions';
import { infoSelector } from './selectors';
import { serverSliceActions } from './slice';
import { initSubscriptions, subscribeToVoice } from './subscriptions';
import { type TDisconnectInfo } from './types';

let unsubscribeFromServer: (() => void) | null = null;
let unsubscribeFromVoice: (() => void) | null = null;
let currentHandshakeHash: string | null = null;

export const setConnected = (status: boolean) => {
  store.dispatch(serverSliceActions.setConnected(status));
};

export const resetServerState = () => {
  store.dispatch(serverSliceActions.resetState());
};

export const setDisconnectInfo = (info: TDisconnectInfo | undefined) => {
  store.dispatch(serverSliceActions.setDisconnectInfo(info));
};

export const setConnecting = (status: boolean) => {
  store.dispatch(serverSliceActions.setConnecting(status));
};

export const setReconnecting = (status: boolean) => {
  store.dispatch(serverSliceActions.setReconnecting(status));
};

export const setReconnectAttempt = (attempt: number) => {
  store.dispatch(serverSliceActions.setReconnectAttempt(attempt));
};

export const setServerId = (id: string) => {
  store.dispatch(serverSliceActions.setServerId(id));
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

  const { serverId } = info;

  const host = getHostFromServer();
  const trpc = await connectToTRPC(host);

  const { hasPassword, handshakeHash } = await trpc.others.handshake.query();

  currentHandshakeHash = handshakeHash;

  if (hasPassword) {
    // show password prompt
    openDialog(Dialog.SERVER_PASSWORD, { handshakeHash, serverId });
    return;
  }

  // Restore last active server from localStorage
  const savedServerId = getSavedActiveServerId();
  await joinServer(handshakeHash, undefined, savedServerId);
};

export const joinServer = async (
  handshakeHash: string,
  password?: string,
  serverId?: number
) => {
  const trpc = getHomeTRPCClient();
  const data = await trpc.others.joinServer.query({
    handshakeHash,
    password,
    serverId
  });

  logDebug('joinServer', data);

  // Unsubscribe from previous server if switching
  unsubscribeFromServer?.();
  unsubscribeFromServer = initSubscriptions();

  // Re-subscribe voice (always re-create after reconnect or first connect)
  unsubscribeFromVoice?.();
  unsubscribeFromVoice = subscribeToVoice();

  store.dispatch(serverSliceActions.setInitialData(data));

  // Track the active server's DB id
  if (data.serverDbId) {
    setActiveServerId(data.serverDbId);
  }

  setPluginCommands(data.commands);

  // Fetch friends, DM data, joined servers, and unread counts in parallel
  fetchFriends();
  fetchFriendRequests();
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
  cleanup(true);
  unsubscribeFromServer?.();
  unsubscribeFromVoice?.();
  unsubscribeFromVoice = null;
  currentHandshakeHash = null;

  // Clear E2EE keys from IndexedDB so the next user doesn't inherit them
  import('@/lib/e2ee').then(({ signalStore }) =>
    signalStore.clearAll().catch(() => {})
  );
};
