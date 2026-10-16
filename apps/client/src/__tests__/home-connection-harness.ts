/**
 * Shared fixtures for tests of the home connection lifecycle
 * (features/server/actions, features/app/actions, lib/reconnect).
 *
 * The real reducers back a store of our own; tRPC clients are recording
 * proxies that answer `.query()` / `.mutate()` from per-route handlers
 * and keep every `.subscribe()` so a test can emit events into them
 * and count how often a route was subscribed.
 *
 * `mock.module` is process-wide in bun:test and the lib/e2ee harness
 * replaces `@/features/store` and `@/lib/trpc` for the rest of the run.
 * This module installs its own replacements for the same two, and —
 * because a module body runs once per process — every test file calls
 * `installConnectionMocks()` itself before it imports the code under
 * test, re-asserting the mocks over anything that ran in between.
 *
 * Importers MUST import '@/lib/e2ee/__tests__/instance-dom-stubs'
 * before this module (the actions graph constructs an AudioContext on
 * load) and import the actions modules dynamically after
 * `installConnectionMocks()`.
 */

import { afterAll, mock, spyOn } from 'bun:test';
import { __testing as preferencesSync } from '@/lib/preferences-sync';
import { configureStore } from '@reduxjs/toolkit';
import { appSliceActions, appSliceReducer } from '@/features/app/slice';
import { dialogSliceReducer } from '@/features/dialogs/slice';
import { dmsSliceReducer } from '@/features/dms/slice';
import { friendsSliceReducer } from '@/features/friends/slice';
import { nameplatesSliceReducer } from '@/features/nameplates/slice';
import { serverScreenSliceReducer } from '@/features/server-screens/slice';
import { serverSliceActions, serverSliceReducer } from '@/features/server/slice';
import type { TFederatedServerEntry } from '@/features/app/slice';

// --- Redux: the real reducers, a store of our own ---

export const testStore = configureStore({
  reducer: {
    app: appSliceReducer,
    server: serverSliceReducer,
    dialog: dialogSliceReducer,
    serverScreen: serverScreenSliceReducer,
    friends: friendsSliceReducer,
    dms: dmsSliceReducer,
    nameplates: nameplatesSliceReducer
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({ serializableCheck: false })
});

// --- tRPC: recording proxies with subscriptions ---

export type RecordedCall = { path: string; input: unknown };
export type RouteHandlers = Record<string, (input: unknown) => unknown>;

type Subscription = {
  onData: (data: unknown) => unknown;
  onError: (err: unknown) => void;
  active: boolean;
};

export type FakeClient = {
  trpc: never;
  calls: RecordedCall[];
  handlers: RouteHandlers;
  /** Calls made to one route, in order. */
  callsTo: (path: string) => RecordedCall[];
  /** Deliver an event to every live subscription of a route. */
  emit: (path: string, data: unknown) => Promise<void>;
  /** How many times a route was subscribed over the client's life. */
  subscribeCount: (path: string) => number;
  /** How many subscriptions of a route are live right now. */
  activeSubscriptions: (path: string) => number;
};

/**
 * A tRPC proxy that resolves `a.b.c.query(input)` / `.mutate(input)` to
 * `handlers['a.b.c'](input)` and records every call; a route with no
 * handler rejects, so a test that forgot to model a dependency fails
 * loudly instead of silently returning undefined. `a.b.subscribe(_,
 * opts)` registers a live subscription until its `unsubscribe()`.
 */
export function fakeClient(handlers: RouteHandlers = {}): FakeClient {
  const calls: RecordedCall[] = [];
  const subscriptions = new Map<string, Subscription[]>();

  const make = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get(_target, prop) {
        if (prop === 'query' || prop === 'mutate') {
          return async (input: unknown) => {
            const route = path.join('.');
            calls.push({ path: route, input });
            const handler = handlers[route];
            if (!handler) {
              throw new Error(`fakeClient: no handler for ${route}`);
            }
            return handler(input);
          };
        }
        if (prop === 'subscribe') {
          return (
            _input: unknown,
            opts: { onData: (data: unknown) => unknown; onError: (err: unknown) => void }
          ) => {
            const route = path.join('.');
            const sub: Subscription = { ...opts, active: true };
            const list = subscriptions.get(route) ?? [];
            list.push(sub);
            subscriptions.set(route, list);
            return {
              unsubscribe: () => {
                sub.active = false;
              }
            };
          };
        }
        if (prop === 'then') return undefined;
        return make([...path, String(prop)]);
      }
    });

  return {
    trpc: make([]) as never,
    calls,
    handlers,
    callsTo: (path) => calls.filter((c) => c.path === path),
    emit: async (path, data) => {
      for (const sub of subscriptions.get(path) ?? []) {
        if (sub.active) await sub.onData(data);
      }
    },
    subscribeCount: (path) => (subscriptions.get(path) ?? []).length,
    activeSubscriptions: (path) =>
      (subscriptions.get(path) ?? []).filter((s) => s.active).length
  };
}

/** What the mocked `@/lib/trpc` answers with. */
export const clients: {
  home: FakeClient | null;
  remotes: Record<string, FakeClient>;
  connectCalls: number;
  cleanupCalls: number;
} = { home: null, remotes: {}, connectCalls: 0, cleanupCalls: 0 };

/** Register (or re-register) this harness's module replacements. */
export function installConnectionMocks(): void {
  // A home join seeds the user's preferences through lib/preferences-sync,
  // whose flush is debounced and, when no client answers, re-armed every
  // few seconds for good. Left alone after a file's last test, that
  // timer outlives the file and the flush lands on whatever fake home a
  // LATER file installs — an unexplained `users.updatePreferences` in the
  // middle of someone else's assertions. Registered here (called at the
  // top of every harness file) so each file drains its own queue.
  afterAll(() => {
    preferencesSync.reset();
  });
  mock.module('@/features/store', () => ({ store: testStore }));
  mock.module('@/lib/trpc', () => ({
    getHomeTRPCClient: () => clients.home?.trpc ?? null,
    getTRPCClient: () => {
      const domain = testStore.getState().app.activeInstanceDomain;
      if (domain) return clients.remotes[domain]?.trpc ?? null;
      return clients.home?.trpc ?? null;
    },
    // Voice calls route by the session's pinned instance, not the one in
    // focus (same resolver shape as lib/trpc's getVoiceTRPCClient).
    getVoiceTRPCClient: () => {
      const domain = testStore.getState().server.voiceInstanceDomain;
      if (domain) return clients.remotes[domain]?.trpc ?? null;
      return clients.home?.trpc ?? null;
    },
    connectToTRPC: () => {
      clients.connectCalls++;
      if (!clients.home) {
        throw new Error('fake home socket: no home client installed');
      }
      return clients.home.trpc;
    },
    cleanup: () => {
      clients.cleanupCalls++;
    }
  }));
}

installConnectionMocks();

// Everything below depends on the mocks above being in place.
const { connectionManager } = await import('@/lib/connection-manager');
const e2ee = await import('@/lib/e2ee');

// --- Fixtures ---

/** A home joinServer response for the home server `id`. */
export function homeJoinData(id: number, extra: Record<string, unknown> = {}) {
  return {
    serverId: `home-${id}`,
    serverDbId: id,
    ownUserId: 10,
    categories: [],
    channels: [],
    roles: [],
    channelPermissions: {},
    readStates: {},
    mentionStates: {},
    lastReadMessageIds: {},
    commands: {},
    ...extra
  };
}

/** A remote joinServer response for the federated server `id`. */
export function remoteJoinData(domain: string, id: number) {
  return {
    serverId: `srv-${domain}-${id}`,
    serverDbId: id,
    ownUserId: 77,
    categories: [],
    channels: [
      {
        id: 500,
        publicId: `chan-${domain}-500`,
        name: 'general',
        type: 'text',
        serverId: id,
        position: 0
      }
    ],
    roles: [],
    channelPermissions: {},
    readStates: { 500: 4 },
    mentionStates: { 500: 1 },
    lastReadMessageIds: {},
    commands: {}
  };
}

/** Handlers every home join fans out to, with empty answers. */
export function homeHandlers(servers: { id: number; name: string }[]): RouteHandlers {
  return {
    'others.handshake': () => ({ handshakeHash: 'hash' }),
    'others.joinServer': (input) => {
      const { serverId } = input as { serverId?: number };
      return homeJoinData(serverId ?? servers[0]?.id ?? 1);
    },
    'others.getServerMembers': () => [],
    'others.getServerEmojis': () => [],
    'others.getServerVoiceState': () => ({ voiceMap: {}, externalStreamsMap: {} }),
    'nameplates.getAll': () => [],
    'friends.getAll': () => [],
    'friends.getRequests': () => [],
    'blocks.getBlocked': () => [],
    'dms.getChannels': () => [],
    'dms.getActiveCalls': () => [],
    'servers.getUnreadCounts': () => ({ unreadCounts: {}, mentionCounts: {} }),
    'servers.getAll': () =>
      servers.map((s) => ({ id: s.id, publicId: `home-${s.id}`, name: s.name, logo: null })),
    'users.updatePreferences': () => ({})
  };
}

/** Handlers a federated switch fans out to. */
export function remoteHandlers(domain: string): RouteHandlers {
  return {
    'others.joinServer': (input) => {
      const { serverId } = input as { serverId: number };
      return remoteJoinData(domain, serverId);
    },
    'others.getServerMembers': () => [],
    'others.getServerEmojis': () => [],
    'others.getServerVoiceState': () => ({ voiceMap: {}, externalStreamsMap: {} }),
    'nameplates.getAll': () => [],
    // Logo self-heal after a switch (entries persist without one).
    'servers.getAll': () => []
  };
}

export function federatedEntry(
  instanceDomain: string,
  serverId: number
): TFederatedServerEntry {
  return {
    instanceDomain,
    instanceName: instanceDomain,
    remoteUrl: `https://${instanceDomain}`,
    server: {
      id: serverId,
      name: `Remote ${serverId}`,
      publicId: `srv-${instanceDomain}-${serverId}`,
      logo: null
    },
    federationToken: 'token',
    // Far from expiry so the switch does not try to re-mint.
    tokenExpiresAt: Date.now() + 24 * 3_600_000
  };
}

type Spies = { mockRestore: () => void }[];

/**
 * Route client lookups: `home` answers getHomeTRPCClient and
 * connectToTRPC; `remotes[domain]` answers the connection manager, which
 * also reports every remote as connected so a switch never tries to
 * open a socket. E2EE bootstrap on the remote is a no-op.
 */
export function installClients(opts: {
  home: FakeClient | null;
  remotes?: Record<string, FakeClient>;
}): () => void {
  clients.home = opts.home;
  clients.remotes = opts.remotes ?? {};
  clients.connectCalls = 0;
  clients.cleanupCalls = 0;
  const spies: Spies = [
    spyOn(connectionManager, 'getRemoteTRPCClient').mockImplementation(
      (domain: string) => (clients.remotes[domain]?.trpc ?? null) as never
    ),
    spyOn(connectionManager, 'getConnection').mockImplementation(
      (domain: string) =>
        (clients.remotes[domain] ? { instanceDomain: domain } : null) as never
    ),
    spyOn(connectionManager, 'isConnected').mockImplementation(
      (domain: string) => clients.remotes[domain] !== undefined
    ),
    spyOn(connectionManager, 'getConnectedDomains').mockImplementation(() =>
      Object.keys(clients.remotes)
    ),
    spyOn(e2ee, 'initE2EEForInstance').mockResolvedValue(undefined)
  ];
  return () => {
    for (const spy of spies) spy.mockRestore();
    clients.home = null;
    clients.remotes = {};
  };
}

/** Back to a logged-in-but-empty state. */
export function resetConnectionState(): void {
  testStore.dispatch(serverSliceActions.resetState());
  testStore.dispatch(serverSliceActions.setInfo({ name: 'test' } as never));
  testStore.dispatch(appSliceActions.setHomeOwnUserId(undefined));
  testStore.dispatch(appSliceActions.setActiveInstanceDomain(null));
  testStore.dispatch(appSliceActions.setActiveServerId(undefined));
  testStore.dispatch(appSliceActions.setFederatedServers([]));
  testStore.dispatch(appSliceActions.setJoinedServers([]));
  testStore.dispatch(appSliceActions.setServerUnreadCounts({}));
  testStore.dispatch(appSliceActions.setServerMentionCounts({}));
  testStore.dispatch(appSliceActions.setActiveView('home'));
  localStorage.clear();
  // See installConnectionMocks: no queued preference flush from an earlier
  // test may surface in this one.
  preferencesSync.reset();
}

/** Let fire-and-forget fetches and queued microtasks settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}
