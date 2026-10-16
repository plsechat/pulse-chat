import {
  getUrlFromServer,
  registerRemoteInstanceUrl
} from '@/helpers/get-file-url';
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
import {
  fetchAndProcessFederatedSenderKeys,
  initE2EE,
  initE2EEForInstance
} from '@/lib/e2ee';
import { getHomeTRPCClient } from '@/lib/trpc';
import { clearSession, getAccessToken, initSupabase, refreshLocalSession, setOidcSession } from '@/lib/supabase';
import type { TServerInfo, TServerSummary } from '@pulse/shared';
import { toast } from 'sonner';
import {
  beginServerJoin,
  connect,
  fetchDeferredServerData,
  isCurrentServerJoin,
  joinServer,
  reinitServerSubscriptions,
  setInfo
} from '../server/actions';
import { startServerPreview } from '../server/preview/actions';
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
    if (!trpc) return [];
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
    if (!trpc) return;
    const { unreadCounts, mentionCounts } = await trpc.servers.getUnreadCounts.query();
    store.dispatch(appSliceActions.setServerUnreadCounts(unreadCounts));
    store.dispatch(appSliceActions.setServerMentionCounts(mentionCounts));
  } catch (error) {
    console.error('Error fetching server unread counts:', error);
  }
};

/**
 * Whether the server slice currently holds `serverId`'s data. Decided by
 * the snapshot itself (its publicId) rather than by `activeServerId`:
 * that id is kept across a context leave so the return path knows where
 * to go, and a home server can share its numeric id with the federated
 * server that was in focus before — either way the slice must be
 * reloaded.
 */
const isHomeServerLoaded = (serverId: number) => {
  const { app, server } = store.getState();
  if (app.activeInstanceDomain || server.serverId === undefined) return false;
  const entry = app.joinedServers.find((s) => s.id === serverId);
  return entry !== undefined && entry.publicId === server.serverId;
};

export const switchServer = async (
  serverId: number,
  handshakeHash: string
) => {
  // Already viewing this server — nothing to do
  const { app } = store.getState();
  const loaded = isHomeServerLoaded(serverId);
  if (app.activeView === 'server' && loaded) {
    return;
  }

  // Clear federation context so tRPC routes go to home instance
  setActiveInstanceDomain(null);
  store.dispatch(appSliceActions.setActiveServerId(serverId));
  setActiveView('server');

  // If the server data is already loaded (e.g. returning from Home view),
  // skip re-joining — subscriptions and state are already active
  if (loaded) {
    return;
  }

  // Re-join with the new serverId to load its data
  await joinServer(handshakeHash, serverId);
};

/**
 * Leave the server in focus for the home view (DMs, friends). A
 * federated server's context is dropped with it: routing goes back to
 * the home instance, the remote snapshot leaves the slice (it fed the
 * tab title and every ambient id while nothing on screen used it) and
 * the server-scoped subscriptions rebind to the home client. The user's
 * voice session survives, and `activeServerId` is kept so the rail
 * knows which server to re-join on the way back. A home server's
 * snapshot stays: returning to it is instant and nothing routes wrongly.
 */
export const leaveServerContext = () => {
  const { app } = store.getState();
  setActiveView('home');
  if (!app.activeInstanceDomain) return;

  setActiveInstanceDomain(null);
  store.dispatch(serverSliceActions.resetStateKeepVoice());
  reinitServerSubscriptions();
};

export const createServer = async (
  name: string,
  description?: string
): Promise<TServerSummary | undefined> => {
  try {
    const trpc = getHomeTRPCClient();
    if (!trpc) return undefined;
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
    if (!trpc) return undefined;
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
    if (!trpc) return;
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
    if (!trpc) return;
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
    // Land in a read-only preview instead of instant-joining — the
    // preview banner's Join button consumes the invite (servers.join).
    await startServerPreview({ inviteCode });
  } catch (error) {
    console.error('Failed to preview server from invite URL:', error);
  }

  // Clean the invite code from the URL
  const url = new URL(window.location.href);
  url.searchParams.delete('invite');
  window.history.replaceState({}, '', url.toString());
};

/**
 * Consume a native-OIDC redirect. The server's /auth/oidc/callback sends
 * the freshly-minted session token in the URL fragment (never sent to a
 * server) and, on failure, an ?oidc_error query param. Runs before the
 * session check so a returning OIDC user is auto-connected.
 */
const consumeOidcRedirect = async (): Promise<void> => {
  // Error path (query string).
  const params = new URLSearchParams(window.location.search);
  const oidcError = params.get('oidc_error');
  if (oidcError) {
    toast.error(oidcError);
    params.delete('oidc_error');
    const search = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`
    );
  }

  // Success path (URL fragment).
  if (!window.location.hash) return;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const token = hash.get('pulse_oidc_token');
  if (!token) return;

  await setOidcSession(token);

  // Strip the token from the URL so it isn't left in history / shareable.
  hash.delete('pulse_oidc_token');
  const rest = hash.toString();
  window.history.replaceState(
    {},
    '',
    `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`
  );
};

export const loadApp = async () => {
  await consumeOidcRedirect();

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

  // Proactively rotate a local-backend session so a week-old access
  // token renews from the 30-day refresh token instead of failing.
  // No-op for supabase mode (supabase-js auto-refreshes) and for OIDC
  // sessions (no refresh token — see refreshLocalSession).
  await refreshLocalSession(getUrlFromServer());

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
        // A 401 means the stored token is no longer valid for a live account
        // (expired, or the account/DB was reset). Clear it so a stale token
        // doesn't keep failing on every refresh and the login screen shows.
        if (provisionRes.status === 401) {
          await clearSession();
        }
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
  setActiveInstanceDomain(null);
  // Clean up federated unread subscriptions
  for (const [, sub] of federatedUnreadSubs) {
    sub.unsubscribe();
  }
  federatedUnreadSubs.clear();
  connectionManager.disconnectAll();
};

// --- Federation actions ---

export const joinFederatedServer = async (
  instanceDomain: string,
  instanceName: string,
  remoteUrl: string,
  remoteServerPublicId: string,
  federationToken: string,
  tokenExpiresAt: number,
  password?: string
) => {
  try {
    console.log('[joinFederatedServer] connecting to remote:', instanceDomain, remoteUrl);
    // Let file URLs resolve against the server-provided base instead of
    // guessing the protocol from the domain string.
    registerRemoteInstanceUrl(instanceDomain, remoteUrl);
    // Connect to remote instance
    connectionManager.connectRemote(
      instanceDomain,
      remoteUrl,
      federationToken,
      tokenExpiresAt
    );
    console.log('[joinFederatedServer] connected, getting remote tRPC client...');

    const remoteTrpc = connectionManager.getRemoteTRPCClient(instanceDomain);
    if (!remoteTrpc) {
      throw new Error('Failed to get remote tRPC client');
    }
    console.log('[joinFederatedServer] got remote tRPC client, joining server publicId:', remoteServerPublicId);

    // Join the remote server via the federated join route
    const server = await remoteTrpc.servers.joinFederated.mutate({
      publicId: remoteServerPublicId,
      password
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
    if (!homeTrpc) {
      toast.success(`Joined ${server.name} on ${instanceName}`);
      await switchToFederatedServer(instanceDomain, server.id);
      return entry;
    }
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
    throw error;
  }
};

/**
 * Local-only removal of a federated server entry plus, when it was the
 * last entry on its instance, full instance-connection teardown (unread
 * subscription, cached counts, WS connection, status badge). Shared by
 * the user-initiated leave flow and the FEDERATED_SERVER_REMOVED event
 * (remote kick/ban) — without the teardown, the connection manager
 * keeps retrying an instance that will never accept us again.
 */
export const cleanupFederatedServerEntry = (
  instanceDomain: string,
  serverId: number
) => {
  store.dispatch(
    appSliceActions.removeFederatedServer({ instanceDomain, serverId })
  );
  saveFederatedServers();

  // Check if any servers remain on this instance
  const remaining = store
    .getState()
    .app.federatedServers.filter((s) => s.instanceDomain === instanceDomain);

  if (remaining.length === 0) {
    teardownFederatedUnreadSubscription(instanceDomain);
    store.dispatch(appSliceActions.clearFederatedCountsForInstance(instanceDomain));
    connectionManager.disconnectRemote(instanceDomain);
    store.dispatch(
      appSliceActions.clearFederatedConnectionStatus(instanceDomain)
    );
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
    // Local cleanup still proceeds — the rail must not keep a server
    // the user asked to leave — but the remote membership may linger,
    // so say so instead of pretending the leave was clean.
    console.error('Failed to leave remote server:', error);
    toast.warning(
      'Could not notify the remote server; it may still list you as a member'
    );
  }

  // Remove membership from home server (fire-and-forget)
  const homeTrpc = getHomeTRPCClient();
  if (homeTrpc) {
    homeTrpc.federation.leaveRemote
    .mutate({ instanceDomain, remoteServerId: serverId })
    .catch((err) =>
      console.error('Failed to remove federation membership:', err)
    );
  }

  cleanupFederatedServerEntry(instanceDomain, serverId);

  leaveServerContext();
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

  // Already viewing this federated server — nothing to do. The slice
  // must actually hold it (publicId match): after a context leave or a
  // reconnect the ids can agree while the snapshot is gone or home's.
  if (
    state.app.activeView === 'server' &&
    state.app.activeServerId === serverId &&
    state.app.activeInstanceDomain === instanceDomain &&
    state.server.serverId === entry.server.publicId
  ) {
    return;
  }

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
    // A new socket means a new tRPC client: a subscription held on the
    // old one is dead, so drop it and let the 'connected' status event
    // re-create it on the new client.
    teardownFederatedUnreadSubscription(instanceDomain);
    connectionManager.reconnectRemote(
      instanceDomain,
      entry.remoteUrl,
      entry.federationToken,
      entry.tokenExpiresAt
    );
  } else if (!connectionManager.isConnected(instanceDomain)) {
    connectionManager.connectRemote(
      instanceDomain,
      entry.remoteUrl,
      entry.federationToken,
      entry.tokenExpiresAt
    );
  }

  // Refresh token if close to expiry (within 1 hour)
  if (entry.tokenExpiresAt - Date.now() < 60 * 60 * 1000) {
    await refreshFederationToken(instanceDomain);
  }

  // Set active state optimistically
  store.dispatch(appSliceActions.setActiveServerId(serverId));
  setActiveInstanceDomain(instanceDomain);
  setActiveView('server');

  // Load channel/category/user data from the remote instance
  const join = beginServerJoin();
  try {
    const remoteTrpc = connectionManager.getRemoteTRPCClient(instanceDomain);
    if (!remoteTrpc) {
      throw new Error('No remote tRPC client available');
    }

    const data = await remoteTrpc.others.joinServer.query({
      handshakeHash: '',
      serverId
    });

    // Superseded by a later join (home or federated) — its response is
    // the one the user asked for; this one must not overwrite it.
    if (!isCurrentServerJoin(join)) return;

    store.dispatch(serverSliceActions.setInitialData(data));
    // Cache our user id within this federated instance so flows like
    // Phase B redistribute can target each instance's chains under
    // the right author id without re-fetching joinServer.
    store.dispatch(
      appSliceActions.setFederatedOwnUserId({
        instanceDomain,
        ownUserId: data.ownUserId
      })
    );
    saveFederatedServers();

    // Fetch deferred data (members, emojis, voice state) from the remote instance
    fetchDeferredServerData(remoteTrpc, data.serverId);

    // Reinit subscriptions so they use the remote tRPC client
    reinitServerSubscriptions();

    // Initialize E2EE keys on the federated instance
    initE2EEForInstance(instanceDomain).catch((err) =>
      console.error('[E2EE] Federation E2EE init failed:', err)
    );

    // Self-heal: fetch full server info if logo is missing
    if (!entry.server.logo) {
      remoteTrpc.servers.getAll.query().then((servers) => {
        const match = servers.find((s) => s.id === serverId);
        if (match) {
          store.dispatch(
            appSliceActions.updateFederatedServerInfo({
              instanceDomain,
              serverId,
              server: match
            })
          );
          saveFederatedServers();
        }
      }).catch(() => {});
    }
  } catch (error) {
    console.error('Failed to load federated server data:', error);
    // A later join owns the UI now; rolling back would undo it.
    if (!isCurrentServerJoin(join)) return;
    toast.error('Failed to connect to federated server');

    // Rollback to previous state
    store.dispatch(appSliceActions.setActiveServerId(prevServerId));
    setActiveInstanceDomain(prevInstanceDomain);
    setActiveView(prevView);
  }
};

export const setActiveInstanceDomain = (domain: string | null) => {
  store.dispatch(appSliceActions.setActiveInstanceDomain(domain));
};

export const saveFederatedServers = () => {
  const state = store.getState();
  setLocalStorageItemAsJSON(
    LocalStorageKey.FEDERATED_SERVERS,
    state.app.federatedServers
  );
};

/**
 * Drop a server entry — home or federated — matched by its globally-unique
 * publicId. Numeric server ids are instance-local and collide across
 * federated instances: a SERVER_MEMBER_LEAVE/USER_KICKED event arriving from
 * a federated connection must never remove the HOME server that happens to
 * share the same numeric id. Matching by publicId makes that impossible.
 */
export const removeServerEntryByPublicId = (serverPublicId: string) => {
  const state = store.getState();

  const homeServer = state.app.joinedServers.find(
    (s) => s.publicId === serverPublicId
  );
  if (homeServer) {
    store.dispatch(appSliceActions.removeJoinedServer(homeServer.id));
    return;
  }

  const fedEntry = state.app.federatedServers.find(
    (e) => e.server.publicId === serverPublicId
  );
  if (fedEntry) {
    store.dispatch(
      appSliceActions.removeFederatedServer({
        instanceDomain: fedEntry.instanceDomain,
        serverId: fedEntry.server.id
      })
    );
    saveFederatedServers();
  }
};

// Track federated unread count subscriptions so we can clean up
const federatedUnreadSubs = new Map<string, { unsubscribe: () => void }>();

/**
 * Drop the unread subscription for an instance. Every path that loses
 * the connection (permanent close, max reconnects, explicit disconnect,
 * a socket replaced by reconnectRemote) goes through here — a stale
 * handle left in the map made setupFederatedUnreadSubscriptions skip
 * the instance forever, so the badge froze after the first drop.
 */
const teardownFederatedUnreadSubscription = (instanceDomain: string) => {
  const sub = federatedUnreadSubs.get(instanceDomain);
  if (!sub) return;
  sub.unsubscribe();
  federatedUnreadSubs.delete(instanceDomain);
};

/**
 * Mint a fresh federation token at the home instance and store it on
 * the entry, in localStorage and on the live connection. Used on a
 * near-expiry switch, by the connection manager when a peer bounces an
 * expired token, and proactively before a reconnect. Null when the home
 * client is gone or refused.
 */
const refreshFederationToken = async (
  instanceDomain: string
): Promise<{ token: string; expiresAt: number } | null> => {
  try {
    const trpc = getHomeTRPCClient();
    if (!trpc) return null;
    const { token, expiresAt } = await trpc.federation.requestToken.mutate({
      targetDomain: instanceDomain
    });

    store.dispatch(
      appSliceActions.updateFederatedToken({
        instanceDomain,
        token,
        expiresAt
      })
    );

    connectionManager.updateToken(instanceDomain, token, expiresAt);
    saveFederatedServers();
    return { token, expiresAt };
  } catch (error) {
    console.error('Failed to refresh federation token:', error);
    return null;
  }
};

const setupFederatedUnreadSubscriptions = (instanceDomain: string) => {
  // Avoid duplicate subscriptions for the same instance
  if (federatedUnreadSubs.has(instanceDomain)) return;

  const remoteTrpc = connectionManager.getRemoteTRPCClient(instanceDomain);
  if (!remoteTrpc) return;

  // Subscribe to real-time unread count updates
  const sub = remoteTrpc.servers.onUnreadCountUpdate.subscribe(undefined, {
    onData: (data: { serverId: number; count: number; mentionCount: number }) => {
      store.dispatch(
        appSliceActions.setFederatedUnreadCount({
          instanceDomain,
          serverId: data.serverId,
          count: data.count,
          mentionCount: data.mentionCount
        })
      );
    },
    onError: (err) =>
      console.error(`[federation] onUnreadCountUpdate error for ${instanceDomain}:`, err)
  });

  federatedUnreadSubs.set(instanceDomain, sub);

  // Fetch initial unread counts
  remoteTrpc.servers.getUnreadCounts
    .query()
    .then(({ unreadCounts, mentionCounts }) => {
      store.dispatch(
        appSliceActions.setFederatedUnreadCounts({
          instanceDomain,
          unreadCounts,
          mentionCounts
        })
      );
    })
    .catch((err) =>
      console.error(`[federation] getUnreadCounts failed for ${instanceDomain}:`, err)
    );
};

export const loadFederatedServers = async () => {
  // The manager re-mints through the home client when a peer bounces an
  // expired token or one is about to expire (idempotent — last wins).
  connectionManager.setTokenRefreshHandler(refreshFederationToken);

  // Register connection status handler (idempotent — last handler wins)
  connectionManager.setStatusChangeHandler((domain, status) => {
    store.dispatch(
      appSliceActions.setFederatedConnectionStatus({
        instanceDomain: domain,
        status
      })
    );

    // The unread subscription follows the socket: (re)created on every
    // open, dropped on every loss, so a connection that comes back
    // after a token re-mint or a peer restart gets its badge back.
    if (status === 'connected') {
      setupFederatedUnreadSubscriptions(domain);
      // Sender keys that landed on this host while we were away were
      // announced over the home socket at the time; nothing re-sends
      // that wake-up, so every (re)connect pulls what is still waiting.
      fetchAndProcessFederatedSenderKeys(domain).catch((err) =>
        console.warn(`[E2EE] federated SKDM pull failed for ${domain}:`, err)
      );
    }

    // When a federated connection is permanently lost, fall back to home
    if (status === 'disconnected') {
      teardownFederatedUnreadSubscription(domain);
      const s = store.getState();
      if (s.app.activeInstanceDomain === domain) {
        toast.error('Lost connection to federated server');
        leaveServerContext();
      }
    }
  });

  try {
    const trpc = getHomeTRPCClient();
    if (!trpc) return;
    const memberships = await trpc.federation.getJoined.query();

    if (memberships.length === 0) {
      // No server-side memberships — clean up any stale localStorage entries
      store.dispatch(appSliceActions.setFederatedServers([]));
      saveFederatedServers();
      return;
    }

    // Preserve logos from previously saved entries (the API doesn't return them)
    const saved = getLocalStorageItemAsJSON<TFederatedServerEntry[]>(
      LocalStorageKey.FEDERATED_SERVERS
    );
    const savedLogoMap = new Map(
      (saved ?? []).map((e) => [`${e.instanceDomain}:${e.server.id}`, e.server.logo])
    );

    // Peer health from the home instance: a peer our home cannot relay
    // to (older version, unreachable) gets a warning badge on its rail
    // entry. Best-effort — the list is cosmetic here.
    const peerWarnings = new Map<string, string>();
    try {
      for (const inst of await trpc.federation.listActiveInstances.query()) {
        if (inst.lastError) peerWarnings.set(inst.domain, inst.lastError);
      }
    } catch (err) {
      console.error('[federation] listActiveInstances failed:', err);
    }

    const entries: TFederatedServerEntry[] = [];
    for (const m of memberships) {
      try {
        const { token, expiresAt } = await trpc.federation.requestToken.mutate({
          targetDomain: m.instanceDomain
        });

        // The home server computes the peer's protocol (http for LAN /
        // allowlisted-private peers, https otherwise) — never guess it
        // here. The old localhost-only heuristic dialed wss:// against
        // plain-http peers, so previously joined federated servers never
        // reconnected. Fallback only covers a home server predating the
        // remoteUrl field.
        const remoteUrl =
          m.remoteUrl ??
          `${m.instanceDomain.includes('localhost') ? 'http' : 'https'}://${m.instanceDomain}`;

        registerRemoteInstanceUrl(m.instanceDomain, remoteUrl);

        entries.push({
          instanceDomain: m.instanceDomain,
          instanceName: m.instanceName ?? m.instanceDomain,
          remoteUrl,
          server: {
            id: m.remoteServerId,
            publicId: m.remoteServerPublicId,
            name: m.remoteServerName ?? 'Unknown Server',
            logo: savedLogoMap.get(`${m.instanceDomain}:${m.remoteServerId}`) ?? null
          },
          federationToken: token,
          tokenExpiresAt: expiresAt,
          peerWarning: peerWarnings.get(m.instanceDomain)
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

    // Eagerly connect to each federated instance and set up unread subscriptions
    const connectedInstances = new Set<string>();
    for (const entry of entries) {
      if (connectedInstances.has(entry.instanceDomain)) continue;
      connectedInstances.add(entry.instanceDomain);

      connectionManager.connectRemote(
        entry.instanceDomain,
        entry.remoteUrl,
        entry.federationToken,
        entry.tokenExpiresAt
      );
      setupFederatedUnreadSubscriptions(entry.instanceDomain);
    }
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
