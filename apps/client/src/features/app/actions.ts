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

export const switchServer = async (
  serverId: number,
  handshakeHash: string
) => {
  // Clear federation context so tRPC routes go to home instance
  store.dispatch(appSliceActions.setActiveInstanceDomain(null));
  store.dispatch(appSliceActions.setActiveServerId(serverId));
  store.dispatch(appSliceActions.setActiveView('server'));

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
    store.dispatch(appSliceActions.setActiveView('home'));
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
    store.dispatch(appSliceActions.setActiveView('home'));
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

      // Load persisted federated servers
      loadFederatedServers();

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

export const setActiveView = (view: TActiveView) =>
  store.dispatch(appSliceActions.setActiveView(view));

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
  store.dispatch(appSliceActions.setActiveView('home'));
  store.dispatch(appSliceActions.setJoinedServers([]));
  store.dispatch(appSliceActions.setActiveServerId(undefined));
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

  // Check if any servers remain on this instance
  const state = store.getState();
  const remaining = state.app.federatedServers.filter(
    (s) => s.instanceDomain === instanceDomain
  );

  if (remaining.length === 0) {
    connectionManager.disconnectRemote(instanceDomain);
  }

  store.dispatch(appSliceActions.setActiveView('home'));
  store.dispatch(appSliceActions.setActiveInstanceDomain(null));
};

export const switchToFederatedServer = async (
  instanceDomain: string,
  serverId: number
) => {
  const state = store.getState();
  const entry = state.app.federatedServers.find(
    (s) => s.instanceDomain === instanceDomain && s.server.id === serverId
  );

  if (!entry) return;

  // Ensure connection is active
  if (!connectionManager.isConnected(instanceDomain)) {
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

  store.dispatch(appSliceActions.setActiveServerId(serverId));
  store.dispatch(appSliceActions.setActiveInstanceDomain(instanceDomain));
  store.dispatch(appSliceActions.setActiveView('server'));

  // Load channel/category/user data from the remote instance
  try {
    const remoteTrpc = connectionManager.getRemoteTRPCClient(instanceDomain);
    if (!remoteTrpc) {
      toast.error('Failed to connect to remote instance');
      return;
    }

    const data = await remoteTrpc.others.joinServer.query({
      handshakeHash: '',
      serverId
    });

    store.dispatch(serverSliceActions.setInitialData(data));

    // Reinit subscriptions so they use the remote tRPC client
    reinitServerSubscriptions();
  } catch (error) {
    console.error('Failed to load federated server data:', error);
    toast.error('Failed to load federated server data');
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

const saveFederatedServers = () => {
  const state = store.getState();
  setLocalStorageItemAsJSON(
    LocalStorageKey.FEDERATED_SERVERS,
    state.app.federatedServers
  );
};

export const loadFederatedServers = () => {
  const saved = getLocalStorageItemAsJSON<TFederatedServerEntry[]>(
    LocalStorageKey.FEDERATED_SERVERS
  );
  if (saved && saved.length > 0) {
    store.dispatch(appSliceActions.setFederatedServers(saved));
  }
};
