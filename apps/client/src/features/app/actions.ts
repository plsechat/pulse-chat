import { getUrlFromServer } from '@/helpers/get-file-url';
import { setGiphyApiKey } from '@/helpers/giphy';
import {
  getLocalStorageItem,
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  removeLocalStorageItem,
  setLocalStorageItem,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { connectionManager } from '@/lib/connection-manager';
import { initE2EE, initE2EEForInstance } from '@/lib/e2ee';
import { getHomeTRPCClient } from '@/lib/trpc';
import { getAccessToken, initSupabase } from '@/lib/supabase';
import type { TServerInfo, TServerSummary } from '@pulse/shared';
import { toast } from 'sonner';
import { connect, getHandshakeHash, joinServer, reinitServerSubscriptions, setInfo } from '../server/actions';
import { serverSliceActions } from '../server/slice';
import { store } from '../store';
import { appSliceActions } from './slice';
import type { TActiveView, TFederatedServerEntry } from './slice';

export const setAppLoading = (loading: boolean) =>
  store.dispatch(appSliceActions.setAppLoading(loading));

export const fetchServerInfo = async (): Promise<TServerInfo | undefined> => {
  try {
    const url = getUrlFromServer();
    const response = await fetch(`${url}/info`);

    if (!response.ok) {
      throw new Error('Failed to fetch server info');
    }

    const data = await response.json();

    return data;
  } catch (error) {
    console.error('Error fetching server info:', error);
  }
};

export const fetchJoinedServers = async () => {
  try {
    const trpc = getHomeTRPCClient();
    const servers = await trpc.servers.getAll.query();
    store.dispatch(appSliceActions.setJoinedServers(servers));
    return servers;
  } catch (error) {
    console.error('Error fetching joined servers:', error);
    return [];
  }
};

export const fetchServerUnreadCounts = async () => {
  try {
    const trpc = getHomeTRPCClient();
    const { unreadCounts, mentionCounts } = await trpc.servers.getUnreadCounts.query();
    store.dispatch(appSliceActions.setServerUnreadCounts(unreadCounts));
    store.dispatch(appSliceActions.setServerMentionCounts(mentionCounts));
  } catch (error) {
    console.error('Error fetching server unread counts:', error);
  }
};

export const switchServer = async (
  serverId: number,
  handshakeHash: string
) => {
  // Already viewing this server — nothing to do
  const { app } = store.getState();
  if (
    app.activeView === 'server' &&
    app.activeServerId === serverId &&
    !app.activeInstanceDomain
  ) {
    return;
  }

  // Clear federation context so tRPC routes go to home instance
  store.dispatch(appSliceActions.setActiveInstanceDomain(null));
  store.dispatch(appSliceActions.setActiveServerId(serverId));
  setActiveView('server');

  // If the server data is already loaded (e.g. returning from Home view),
  // skip re-joining — subscriptions and state are already active
  if (app.activeServerId === serverId && !app.activeInstanceDomain) {
    return;
  }

  // Re-join with the new serverId to load its data
  await joinServer(handshakeHash, undefined, serverId);
};

export const createServer = async (
  name: string,
  description?: string
): Promise<TServerSummary | undefined> => {
  try {
    const trpc = getHomeTRPCClient();
    const server = await trpc.servers.create.mutate({ name, description });
    store.dispatch(appSliceActions.addJoinedServer(server));
    return server;
  } catch (error) {
    console.error('Error creating server:', error);
    toast.error('Failed to create server');
  }
};

export const joinServerByInvite = async (
  inviteCode: string
): Promise<TServerSummary | undefined> => {
  try {
    const trpc = getHomeTRPCClient();
    const server = await trpc.servers.join.mutate({ inviteCode });
    store.dispatch(appSliceActions.addJoinedServer(server));
    return server;
  } catch (error) {
    console.error('Error joining server:', error);
    toast.error('Failed to join server');
  }
};

export const leaveServer = async (serverId: number) => {
  try {
    const trpc = getHomeTRPCClient();
    await trpc.servers.leave.mutate({ serverId });
    store.dispatch(appSliceActions.removeJoinedServer(serverId));
    setActiveView('home');
    toast.success('Left server');
  } catch (error) {
    console.error('Error leaving server:', error);
    toast.error('Failed to leave server');
  }
};

export const deleteServer = async (serverId: number) => {
  try {
    const trpc = getHomeTRPCClient();
    await trpc.servers.delete.mutate({ serverId });
    store.dispatch(appSliceActions.removeJoinedServer(serverId));
    setActiveView('home');
    toast.success('Server deleted');
  } catch (error) {
    console.error('Error deleting server:', error);
    toast.error('Failed to delete server');
  }
};

const handleInviteFromUrl = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const inviteCode = urlParams.get('invite');

  if (!inviteCode) return;

  try {
    const server = await joinServerByInvite(inviteCode);

    if (server) {
      const hash = getHandshakeHash();

      if (hash) {
        await switchServer(server.id, hash);
      }
    }

    // Clean the invite code from the URL
    const url = new URL(window.location.href);
    url.searchParams.delete('invite');
    window.history.replaceState({}, '', url.toString());
  } catch (error) {
    console.error('Failed to join server from invite URL:', error);
  }
};

export const loadApp = async () => {
  const info = await fetchServerInfo();

  if (!info) {
    console.error('Failed to load server info during app load');
    toast.error('Failed to load server info');
    return;
  }

  setInfo(info);
  setGiphyApiKey(info.giphyApiKey);

  // Initialize Supabase client from server-provided config (supports multi-domain deployment)
  if (info.supabaseUrl && info.supabaseAnonKey) {
    initSupabase(info.supabaseUrl, info.supabaseAnonKey);
  }

  // Try to auto-connect if a valid session exists
  const token = await getAccessToken();

  if (token) {
    try {
      // Provision the user in the app database if they don't exist yet
      // (required for OAuth users who authenticated via Supabase but haven't
      // been registered in the Pulse database)
      const url = getUrlFromServer();
      const provisionRes = await fetch(`${url}/auth/provision`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      });

      if (!provisionRes.ok) {
        const errorData = await provisionRes.json().catch(() => ({}));
        console.error('Provision failed:', errorData);
        throw new Error(errorData.error || 'Failed to provision user');
      }

      // Try connecting directly — the WebSocket validates the token
      await connect();

      // Initialize E2EE (replenishes OTPs if keys exist, otherwise no-op)
      initE2EE().catch((err) =>
        console.error('E2EE initialization failed:', err)
      );

      // Load persisted federated servers and validate against home instance
      await loadFederatedServers();

      // Check for invite code in URL and auto-join that server
      await handleInviteFromUrl();

      setAppLoading(false);
      return;
    } catch (error) {
      console.error('Auto-connect failed, showing login:', error);
      // Don't sign out — just show the login page.
      // The stored session might still be usable for a fresh signInWithPassword.
    }
  }

  setAppLoading(false);
};

export const setModViewOpen = (isOpen: boolean, userId?: number) =>
  store.dispatch(
    appSliceActions.setModViewOpen({
      modViewOpen: isOpen,
      userId
    })
  );

export const setActiveView = (view: TActiveView) => {
  store.dispatch(appSliceActions.setActiveView(view));
  setLocalStorageItem(LocalStorageKey.ACTIVE_VIEW, view);
};

export const getSavedActiveView = (): TActiveView | undefined => {
  const saved = getLocalStorageItem(LocalStorageKey.ACTIVE_VIEW);
  if (saved === 'home' || saved === 'server' || saved === 'discover') {
    return saved;
  }
  return undefined;
};

export const setActiveServerId = (id: number | undefined) => {
  store.dispatch(appSliceActions.setActiveServerId(id));

  if (id !== undefined) {
    setLocalStorageItem(LocalStorageKey.ACTIVE_SERVER_ID, String(id));
  } else {
    removeLocalStorageItem(LocalStorageKey.ACTIVE_SERVER_ID);
  }
};

export const getSavedActiveServerId = (): number | undefined => {
  const saved = getLocalStorageItem(LocalStorageKey.ACTIVE_SERVER_ID);
  return saved ? Number(saved) : undefined;
};

export const resetApp = () => {
  store.dispatch(
    appSliceActions.setModViewOpen({
      modViewOpen: false,
      userId: undefined
    })
  );
  setActiveView('home');
  store.dispatch(appSliceActions.setJoinedServers([]));
  store.dispatch(appSliceActions.setActiveServerId(undefined));
  store.dispatch(appSliceActions.setServerUnreadCounts({}));
  store.dispatch(appSliceActions.setServerMentionCounts({}));
  store.dispatch(appSliceActions.setFederatedServers([]));
  store.dispatch(appSliceActions.setActiveInstanceDomain(null));
  connectionManager.disconnectAll();
};

// --- Federation actions ---

export const joinFederatedServer = async (
  instanceDomain: string,
  instanceName: string,
  remoteUrl: string,
  remoteServerPublicId: string,
  federationToken: string,
  tokenExpiresAt: number
) => {
  try {
    console.log('[joinFederatedServer] connecting to remote:', instanceDomain, remoteUrl);
    // Connect to remote instance
    connectionManager.connectRemote(instanceDomain, remoteUrl, federationToken);
    console.log('[joinFederatedServer] connected, getting remote tRPC client...');

    const remoteTrpc = connectionManager.getRemoteTRPCClient(instanceDomain);
    if (!remoteTrpc) {
      throw new Error('Failed to get remote tRPC client');
    }
    console.log('[joinFederatedServer] got remote tRPC client, joining server publicId:', remoteServerPublicId);

    // Join the remote server via the federated join route
    const server = await remoteTrpc.servers.joinFederated.mutate({
      publicId: remoteServerPublicId
    });
    console.log('[joinFederatedServer] joined server:', server);

    const entry: TFederatedServerEntry = {
      instanceDomain,
      instanceName,
      remoteUrl,
      server,
      federationToken,
      tokenExpiresAt
    };

    store.dispatch(appSliceActions.addFederatedServer(entry));
    saveFederatedServers();

    // Persist membership on home server (fire-and-forget)
    const homeTrpc = getHomeTRPCClient();
    homeTrpc.federation.confirmJoin
      .mutate({
        instanceDomain,
        remoteServerId: server.id,
        remoteServerPublicId,
        remoteServerName: server.name
      })
      .catch((err) =>
        console.error('Failed to persist federation membership:', err)
      );

    toast.success(`Joined ${server.name} on ${instanceName}`);

    // Auto-switch to the newly joined server
    await switchToFederatedServer(instanceDomain, server.id);

    return entry;
  } catch (error) {
    console.error('[joinFederatedServer] error:', error);
    toast.error('Failed to join federated server');
  }
};

export const leaveFederatedServer = async (
  instanceDomain: string,
  serverId: number
) => {
  // Tell the remote server to remove the user before cleaning up locally
  try {
    const remoteTrpc = connectionManager.getRemoteTRPCClient(instanceDomain);
    if (remoteTrpc) {
      await remoteTrpc.servers.leave.mutate({ serverId });
    }
  } catch (error) {
    console.error('Failed to leave remote server:', error);
  }

  store.dispatch(
    appSliceActions.removeFederatedServer({ instanceDomain, serverId })
  );
  saveFederatedServers();

  // Remove membership from home server (fire-and-forget)
  const homeTrpc = getHomeTRPCClient();
  homeTrpc.federation.leaveRemote
    .mutate({ instanceDomain, remoteServerId: serverId })
    .catch((err) =>
      console.error('Failed to remove federation membership:', err)
    );

  // Check if any servers remain on this instance
  const state = store.getState();
  const remaining = state.app.federatedServers.filter(
    (s) => s.instanceDomain === instanceDomain
  );

  if (remaining.length === 0) {
    connectionManager.disconnectRemote(instanceDomain);
    store.dispatch(
      appSliceActions.clearFederatedConnectionStatus(instanceDomain)
    );
  }

  setActiveView('home');
  store.dispatch(appSliceActions.setActiveInstanceDomain(null));
};

export const switchToFederatedServer = async (
  instanceDomain: string,
  serverId: number
) => {
  const state = store.getState();

  // Already viewing this federated server — nothing to do
  if (
    state.app.activeView === 'server' &&
    state.app.activeServerId === serverId &&
    state.app.activeInstanceDomain === instanceDomain
  ) {
    return;
  }

  const entry = state.app.federatedServers.find(
    (s) => s.instanceDomain === instanceDomain && s.server.id === serverId
  );

  if (!entry) return;

  // Save previous state for rollback on failure
  const prevServerId = state.app.activeServerId;
  const prevInstanceDomain = state.app.activeInstanceDomain;
  const prevView = state.app.activeView;

  // Ensure connection is active — reconnect if previously disconnected
  const connStatus =
    state.app.federatedConnectionStatuses[instanceDomain];
  if (
    connStatus === 'disconnected' ||
    !connectionManager.getConnection(instanceDomain)
  ) {
    connectionManager.reconnectRemote(
      instanceDomain,
      entry.remoteUrl,
      entry.federationToken
    );
  } else if (!connectionManager.isConnected(instanceDomain)) {
    connectionManager.connectRemote(
      instanceDomain,
      entry.remoteUrl,
      entry.federationToken
    );
  }

  // Refresh token if close to expiry (within 1 hour)
  if (entry.tokenExpiresAt - Date.now() < 60 * 60 * 1000) {
    try {
      const trpc = getHomeTRPCClient();
      const { token, expiresAt } =
        await trpc.federation.requestToken.mutate({
          targetDomain: instanceDomain
        });

      store.dispatch(
        appSliceActions.updateFederatedToken({
          instanceDomain,
          token,
          expiresAt
        })
      );

      connectionManager.updateToken(instanceDomain, token);
      saveFederatedServers();
    } catch (error) {
      console.error('Failed to refresh federation token:', error);
    }
  }

  // Set active state optimistically
  store.dispatch(appSliceActions.setActiveServerId(serverId));
  store.dispatch(appSliceActions.setActiveInstanceDomain(instanceDomain));
  setActiveView('server');

  // Load channel/category/user data from the remote instance
  try {
    const remoteTrpc = connectionManager.getRemoteTRPCClient(instanceDomain);
    if (!remoteTrpc) {
      throw new Error('No remote tRPC client available');
    }

    const data = await remoteTrpc.others.joinServer.query({
      handshakeHash: '',
      serverId
    });

    store.dispatch(serverSliceActions.setInitialData(data));

    // Reinit subscriptions so they use the remote tRPC client
    reinitServerSubscriptions();

    // Initialize E2EE keys on the federated instance
    initE2EEForInstance(instanceDomain).catch((err) =>
      console.error('[E2EE] Federation E2EE init failed:', err)
    );
  } catch (error) {
    console.error('Failed to load federated server data:', error);
    toast.error('Failed to connect to federated server');

    // Rollback to previous state
    store.dispatch(appSliceActions.setActiveServerId(prevServerId));
    store.dispatch(
      appSliceActions.setActiveInstanceDomain(prevInstanceDomain)
    );
    setActiveView(prevView);
  }
};

export const setActiveInstanceDomain = (domain: string | null) => {
  store.dispatch(appSliceActions.setActiveInstanceDomain(domain));

  if (domain) {
    setLocalStorageItem(LocalStorageKey.ACTIVE_INSTANCE, domain);
  } else {
    removeLocalStorageItem(LocalStorageKey.ACTIVE_INSTANCE);
  }
};

export const saveFederatedServers = () => {
  const state = store.getState();
  setLocalStorageItemAsJSON(
    LocalStorageKey.FEDERATED_SERVERS,
    state.app.federatedServers
  );
};

export const loadFederatedServers = async () => {
  // Register connection status handler (idempotent — last handler wins)
  connectionManager.setStatusChangeHandler((domain, status) => {
    store.dispatch(
      appSliceActions.setFederatedConnectionStatus({
        instanceDomain: domain,
        status
      })
    );

    // When a federated connection is permanently lost, fall back to home
    if (status === 'disconnected') {
      const s = store.getState();
      if (s.app.activeInstanceDomain === domain) {
        toast.error('Lost connection to federated server');
        store.dispatch(appSliceActions.setActiveInstanceDomain(null));
        setActiveView('home');
      }
    }
  });

  try {
    const trpc = getHomeTRPCClient();
    const memberships = await trpc.federation.getJoined.query();

    if (memberships.length === 0) {
      // No server-side memberships — clean up any stale localStorage entries
      store.dispatch(appSliceActions.setFederatedServers([]));
      saveFederatedServers();
      return;
    }

    const entries: TFederatedServerEntry[] = [];
    for (const m of memberships) {
      try {
        const { token, expiresAt } = await trpc.federation.requestToken.mutate({
          targetDomain: m.instanceDomain
        });

        const protocol = m.instanceDomain.includes('localhost')
          ? 'http'
          : 'https';

        entries.push({
          instanceDomain: m.instanceDomain,
          instanceName: m.instanceName ?? m.instanceDomain,
          remoteUrl: `${protocol}://${m.instanceDomain}`,
          server: {
            id: m.remoteServerId,
            publicId: m.remoteServerPublicId,
            name: m.remoteServerName ?? 'Unknown Server',
            logo: null
          },
          federationToken: token,
          tokenExpiresAt: expiresAt
        });
      } catch (err) {
        console.error(
          `Failed to get token for ${m.instanceDomain}:`,
          err
        );
      }
    }

    store.dispatch(appSliceActions.setFederatedServers(entries));
    saveFederatedServers();
  } catch (error) {
    console.error('Failed to load federated servers from server:', error);

    // Fall back to localStorage
    const saved = getLocalStorageItemAsJSON<TFederatedServerEntry[]>(
      LocalStorageKey.FEDERATED_SERVERS
    );
    if (saved && saved.length > 0) {
      store.dispatch(appSliceActions.setFederatedServers(saved));
    }
  }
};
