/**
 * Home connection lifecycle: connect, join, switch, leave.
 *
 *  - home-scoped subscriptions are created once per home connection and
 *    survive server switches; instance-scoped ones follow the server
 *  - a federated server's unread events never reach the home rail map;
 *    the home server's do, even while a federated server is in focus
 *  - overlapping joins resolve to the last requested server
 *  - a reconnect while a federated server is in focus re-enters it
 *  - leaving a federated server's context for the home view routes
 *    home, drops the remote snapshot (keeping voice) and rebinds the
 *    server-scoped subscriptions; returning re-joins
 *
 * Run via: bun test apps/client/src/features/server/__tests__/connection-lifecycle.test.ts
 */

import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appSliceActions } from '@/features/app/slice';
import { serverSliceActions } from '@/features/server/slice';
import {
  fakeClient,
  federatedEntry,
  homeHandlers,
  installClients,
  installConnectionMocks,
  remoteHandlers,
  resetConnectionState,
  settle,
  testStore,
  type FakeClient
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

const serverActions = await import('@/features/server/actions');
const appActions = await import('@/features/app/actions');

const HOME_SERVERS = [
  { id: 1, name: 'Alpha' },
  { id: 2, name: 'Beta' },
  { id: 3, name: 'Gamma' }
];
const PEER = 'peer.example';

let home: FakeClient;
let remote: FakeClient;
let restoreClients: () => void;

beforeEach(() => {
  resetConnectionState();
  home = fakeClient(homeHandlers(HOME_SERVERS));
  remote = fakeClient(remoteHandlers(PEER));
  restoreClients = installClients({ home, remotes: { [PEER]: remote } });
  testStore.dispatch(
    appSliceActions.setFederatedServers([federatedEntry(PEER, 1)])
  );
});

afterEach(() => {
  serverActions.disconnectFromServer();
  restoreClients();
});

const state = () => testStore.getState();

const HOME_SUBS = [
  'servers.onUnreadCountUpdate',
  'servers.onMemberJoin',
  'servers.onMemberLeave',
  'friends.onRequestReceived',
  'dms.onNewMessage',
  'dms.onCallStarted',
  'federation.onServerRemoved',
  'federation.onInstanceUpdate',
  'e2ee.onIdentityReset'
];
const SERVER_SUB = 'channels.onCreate';

describe('connect', () => {
  test('joins the saved home server and subscribes home events once', async () => {
    localStorage.setItem('pulse-active-server-id', '2');

    await serverActions.connect();
    await settle();

    expect(home.callsTo('others.handshake')).toHaveLength(1);
    expect(home.callsTo('others.openSession')[0]!.input).toMatchObject({
      handshakeHash: 'hash',
      serverId: 2
    });
    expect(state().server.serverId).toBe('home-2');
    expect(state().app.activeServerId).toBe(2);
    expect(state().app.homeOwnUserId).toBe(10);
    expect(state().app.activeInstanceDomain).toBeNull();
    for (const path of HOME_SUBS) {
      expect(home.activeSubscriptions(path)).toBe(1);
    }
    expect(home.activeSubscriptions(SERVER_SUB)).toBe(1);
  });

  test('home subscriptions open only after the first join authenticated the socket', async () => {
    // The server refuses a subscription from a socket that has not run
    // others.openSession yet (UNAUTHORIZED) and never retries it, so the
    // join must come first. Record how many home subscriptions existed
    // at the moment the join request was made.
    const original = home.handlers['others.openSession']!;
    let homeSubsAtJoin = -1;
    home.handlers['others.openSession'] = (input) => {
      homeSubsAtJoin = HOME_SUBS.reduce(
        (n, path) => n + home.subscribeCount(path),
        0
      );
      return original(input);
    };

    await serverActions.connect();
    await settle();

    expect(homeSubsAtJoin).toBe(0);
    for (const path of HOME_SUBS) {
      expect(home.activeSubscriptions(path)).toBe(1);
    }
  });

  test('home subscriptions survive three server switches; server ones follow', async () => {
    await serverActions.connect();
    await settle();

    await appActions.switchServer(2, 'hash');
    await appActions.switchToFederatedServer(PEER, 1);
    await appActions.switchServer(1, 'hash');
    await settle();

    for (const path of HOME_SUBS) {
      expect(home.subscribeCount(path)).toBe(1);
      expect(home.activeSubscriptions(path)).toBe(1);
    }
    // connect + switch(2) + switch(1) on home, the federated hop on the remote
    expect(home.subscribeCount(SERVER_SUB)).toBe(3);
    expect(home.activeSubscriptions(SERVER_SUB)).toBe(1);
    expect(remote.subscribeCount(SERVER_SUB)).toBe(1);
    expect(remote.activeSubscriptions(SERVER_SUB)).toBe(0);
    expect(state().server.serverId).toBe('home-1');
  });

  test('a second connect (reconnect) replaces the home subscriptions', async () => {
    await serverActions.connect();
    await settle();
    await serverActions.connect();
    await settle();

    for (const path of HOME_SUBS) {
      expect(home.subscribeCount(path)).toBe(2);
      expect(home.activeSubscriptions(path)).toBe(1);
    }
  });

  test('re-enters the federated server that was in focus before the drop', async () => {
    await serverActions.connect();
    await settle();
    await appActions.switchToFederatedServer(PEER, 1);
    await settle();
    expect(state().server.serverId).toBe(`srv-${PEER}-1`);
    expect(remote.callsTo('others.openSession')).toHaveLength(1);

    // The socket dropped and came back.
    await serverActions.connect();
    await settle();

    expect(state().app.activeInstanceDomain).toBe(PEER);
    expect(state().app.activeServerId).toBe(1);
    expect(state().app.activeView).toBe('server');
    expect(state().server.serverId).toBe(`srv-${PEER}-1`);
    expect(state().server.ownUserId).toBe(77);
    // Home identity is still the home one.
    expect(state().app.homeOwnUserId).toBe(10);
    expect(remote.callsTo('others.openSession')).toHaveLength(2);
    // Server-scoped subscriptions ended up on the remote again.
    expect(remote.activeSubscriptions(SERVER_SUB)).toBe(1);
    expect(home.activeSubscriptions(SERVER_SUB)).toBe(0);
  });
});

describe('unread routing', () => {
  test('remote unread events never touch the home map; home events do, while federated', async () => {
    await serverActions.connect();
    await settle();
    await appActions.switchToFederatedServer(PEER, 1);
    await settle();
    expect(state().app.activeInstanceDomain).toBe(PEER);

    // The remote never had a home-map consumer bound to it.
    expect(remote.subscribeCount('servers.onUnreadCountUpdate')).toBe(0);
    await remote.emit('servers.onUnreadCountUpdate', {
      serverId: 1,
      count: 9,
      mentionCount: 3
    });
    expect(state().app.serverUnreadCounts[1]).toBeUndefined();
    expect(state().app.serverMentionCounts[1]).toBeUndefined();

    await home.emit('servers.onUnreadCountUpdate', {
      serverId: 1,
      count: 4,
      mentionCount: 1
    });
    expect(state().app.serverUnreadCounts[1]).toBe(4);
    expect(state().app.serverMentionCounts[1]).toBe(1);
  });

  test('our own member-join on the home socket lands in the home rail', async () => {
    await serverActions.connect();
    await settle();
    await appActions.switchToFederatedServer(PEER, 1);
    await settle();

    // userId 10 is the home ownUserId from homeJoinData.
    await home.emit('servers.onMemberJoin', {
      serverId: 4,
      serverPublicId: 'home-4',
      userId: 10,
      server: { id: 4, publicId: 'home-4', name: 'Delta', logo: null }
    });
    expect(state().app.joinedServers.map((s) => s.id)).toContain(4);
  });

  test("another user's member-join joins the roster of the viewed server, never the rail", async () => {
    localStorage.setItem('pulse-active-server-id', '2');
    await serverActions.connect();
    await settle();

    const newcomer = { id: 42, name: 'Newcomer', roleIds: [] };
    const summary = { id: 2, publicId: 'home-2', name: 'Beta', logo: null };

    // Viewing home-2: the joiner is added to the roster.
    await home.emit('servers.onMemberJoin', {
      serverId: 2,
      serverPublicId: 'home-2',
      userId: 42,
      server: summary,
      user: newcomer
    });
    expect(state().server.users.map((u) => u.id)).toContain(42);
    expect(state().app.joinedServers.map((s) => s.id)).not.toContain(4);

    // A join to a server we are not viewing leaves the roster alone.
    await home.emit('servers.onMemberJoin', {
      serverId: 3,
      serverPublicId: 'home-3',
      userId: 43,
      server: { id: 3, publicId: 'home-3', name: 'Gamma', logo: null },
      user: { id: 43, name: 'Elsewhere', roleIds: [] }
    });
    expect(state().server.users.map((u) => u.id)).not.toContain(43);
  });
});

describe('openSession sequencing', () => {
  test('overlapping joins resolving out of order land on the last requested server', async () => {
    await serverActions.connect();
    await settle();

    const pending = new Map<number, (value: unknown) => void>();
    home.handlers['others.openSession'] = (input) =>
      new Promise((resolve) => {
        pending.set((input as { serverId: number }).serverId, resolve);
      });

    const first = appActions.switchServer(2, 'hash');
    const second = appActions.switchServer(3, 'hash');
    await settle();
    expect(pending.size).toBe(2);

    // The later request answers first, then the stale one.
    pending.get(3)!({ ...homeData(3) });
    await second;
    await settle();
    pending.get(2)!({ ...homeData(2) });
    await first;
    await settle();

    expect(state().server.serverId).toBe('home-3');
    expect(state().app.activeServerId).toBe(3);
    expect(home.activeSubscriptions(SERVER_SUB)).toBe(1);
  });

  test('a home join superseded by a federated switch is dropped', async () => {
    await serverActions.connect();
    await settle();

    let resolveHome: ((value: unknown) => void) | null = null;
    home.handlers['others.openSession'] = () =>
      new Promise((resolve) => {
        resolveHome = resolve;
      });

    const homeJoin = appActions.switchServer(2, 'hash');
    await settle();
    await appActions.switchToFederatedServer(PEER, 1);
    await settle();
    resolveHome!(homeData(2));
    await homeJoin;
    await settle();

    expect(state().server.serverId).toBe(`srv-${PEER}-1`);
    expect(state().app.activeInstanceDomain).toBe(PEER);
  });
});

describe('leaveServerContext', () => {
  test('from a federated server: routes home, drops the snapshot, keeps voice, rebinds subs', async () => {
    await serverActions.connect();
    await settle();
    await appActions.switchToFederatedServer(PEER, 1);
    await settle();
    expect(state().server.readStatesMap).toEqual({ 500: 4 });
    testStore.dispatch(serverSliceActions.setCurrentVoiceChannelId(500));
    testStore.dispatch(serverSliceActions.setCurrentVoiceServerId(1));
    expect(state().server.currentVoiceChannelPublicId).toBe(`chan-${PEER}-500`);

    appActions.leaveServerContext();
    await settle();

    const { app, server } = state();
    expect(app.activeView).toBe('home');
    expect(app.activeInstanceDomain).toBeNull();
    expect(app.activeServerId).toBe(1);
    // Tab-title inputs no longer see the remote channels.
    expect(server.readStatesMap).toEqual({});
    expect(server.mentionStatesMap).toEqual({});
    expect(server.channels).toEqual([]);
    expect(server.serverId).toBeUndefined();
    expect(server.connected).toBe(true);
    // The voice session is untouched.
    expect(server.currentVoiceChannelId).toBe(500);
    expect(server.currentVoiceServerId).toBe(1);
    expect(server.currentVoiceChannelPublicId).toBe(`chan-${PEER}-500`);
    expect(server.currentVoiceServerPublicId).toBe(`srv-${PEER}-1`);
    // Server-scoped subscriptions are back on the home client.
    expect(remote.activeSubscriptions(SERVER_SUB)).toBe(0);
    expect(home.activeSubscriptions(SERVER_SUB)).toBe(1);
    expect(remote.activeSubscriptions('voice.onJoin')).toBe(0);
    expect(home.activeSubscriptions('voice.onJoin')).toBe(1);
  });

  test('returning to a home server with the same numeric id re-joins', async () => {
    await serverActions.connect();
    await settle();
    await appActions.switchToFederatedServer(PEER, 1);
    await settle();
    appActions.leaveServerContext();
    await settle();
    const joinsBefore = home.callsTo('others.openSession').length;

    await appActions.switchServer(1, 'hash');
    await settle();

    expect(home.callsTo('others.openSession')).toHaveLength(joinsBefore + 1);
    expect(state().server.serverId).toBe('home-1');
    expect(state().app.activeView).toBe('server');
  });

  test('returning to the federated server re-joins it', async () => {
    await serverActions.connect();
    await settle();
    await appActions.switchToFederatedServer(PEER, 1);
    await settle();
    appActions.leaveServerContext();
    await settle();

    await appActions.switchToFederatedServer(PEER, 1);
    await settle();

    expect(remote.callsTo('others.openSession')).toHaveLength(2);
    expect(state().server.serverId).toBe(`srv-${PEER}-1`);
    expect(state().app.activeInstanceDomain).toBe(PEER);
  });

  test('from a home server: only the view changes and returning is instant', async () => {
    await serverActions.connect();
    await settle();
    const joins = home.callsTo('others.openSession').length;
    const serverSubs = home.subscribeCount(SERVER_SUB);

    appActions.leaveServerContext();
    expect(state().app.activeView).toBe('home');
    expect(state().server.serverId).toBe('home-1');

    await appActions.switchServer(1, 'hash');
    expect(home.callsTo('others.openSession')).toHaveLength(joins);
    expect(home.subscribeCount(SERVER_SUB)).toBe(serverSubs);
    expect(state().app.activeView).toBe('server');
  });
});

describe('disconnectFromServer', () => {
  test('tears every subscription down and resets the handshake', async () => {
    await serverActions.connect();
    await settle();

    serverActions.disconnectFromServer();

    for (const path of [...HOME_SUBS, SERVER_SUB, 'voice.onJoin']) {
      expect(home.activeSubscriptions(path)).toBe(0);
    }
    expect(serverActions.getHandshakeHash()).toBeNull();
  });
});

function homeData(id: number) {
  return {
    serverId: `home-${id}`,
    serverDbId: id,
    ownUserId: 10,
    categories: [],
    channels: [],
    roles: [],
    channelPermissions: {},
    readStates: {},
    commands: {}
  };
}
