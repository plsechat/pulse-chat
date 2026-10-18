/**
 * A voice session is pinned to the instance that hosts it; every later
 * voice call routes by that pin, not by the instance the user is looking
 * at.
 *
 *  - a join on home while home is in focus pins "home"; browsing a
 *    federated server afterwards does not move the leave off home
 *  - a join on a federated server pins that instance; going back home
 *    does not move the leave off it
 *  - the pin is cleared with the session
 *  - a DM call is pinned to home and leaves through home while a
 *    federated server is in focus
 *  - a restore (reconnect rejoin) joins the instance it is told to, and
 *    carries the hosting server's identity instead of reading the one
 *    in focus
 *
 * Run via: bun test apps/client/src/features/server/__tests__/voice-instance-pin.test.ts
 */

import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appSliceActions } from '@/features/app/slice';
import { dmsSliceActions } from '@/features/dms/slice';
import {
  fakeClient,
  federatedEntry,
  installClients,
  installConnectionMocks,
  resetConnectionState,
  testStore,
  type FakeClient,
  type RouteHandlers
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

const voiceActions = await import('@/features/server/voice/actions');
const dmActions = await import('@/features/dms/actions');

const PEER = 'peer.example';
const ROUTER_CAPS = { codecs: [], headerExtensions: [] };

const voiceHandlers = (): RouteHandlers => ({
  'voice.join': () => ({ routerRtpCapabilities: ROUTER_CAPS }),
  'voice.leave': () => ({}),
  'dms.voiceJoin': () => ({ routerRtpCapabilities: ROUTER_CAPS }),
  'dms.voiceLeave': () => ({})
});

let home: FakeClient;
let remote: FakeClient;
let restoreClients: () => void;

const browse = (instanceDomain: string | null, serverId: number) => {
  testStore.dispatch(appSliceActions.setActiveInstanceDomain(instanceDomain));
  testStore.dispatch(appSliceActions.setActiveServerId(serverId));
};

beforeEach(() => {
  resetConnectionState();
  // The harness reset covers the server slice only; a DM call from an
  // earlier test must not leak into this one.
  testStore.dispatch(dmsSliceActions.setOwnDmCallChannelId(undefined));
  home = fakeClient(voiceHandlers());
  remote = fakeClient(voiceHandlers());
  restoreClients = installClients({ home, remotes: { [PEER]: remote } });
  testStore.dispatch(
    appSliceActions.setFederatedServers([federatedEntry(PEER, 9)])
  );
  browse(null, 1);
});

afterEach(() => {
  restoreClients();
});

describe('server voice channel pin', () => {
  test('joined on home, browsing a federated server: the leave still lands on home', async () => {
    const caps = await voiceActions.joinVoice(42);

    expect(caps).toEqual(ROUTER_CAPS);
    expect(home.callsTo('voice.join')).toHaveLength(1);
    expect(testStore.getState().server.currentVoiceChannelId).toBe(42);
    expect(testStore.getState().server.voiceInstanceDomain).toBeUndefined();

    browse(PEER, 9);

    await voiceActions.leaveVoice();

    expect(home.callsTo('voice.leave')).toHaveLength(1);
    expect(remote.callsTo('voice.leave')).toHaveLength(0);
    expect(testStore.getState().server.currentVoiceChannelId).toBeUndefined();
  });

  test('joined on a federated server, back home: the leave lands on that instance', async () => {
    browse(PEER, 9);

    await voiceActions.joinVoice(500);

    expect(remote.callsTo('voice.join')).toHaveLength(1);
    expect(home.callsTo('voice.join')).toHaveLength(0);
    expect(testStore.getState().server.voiceInstanceDomain).toBe(PEER);

    browse(null, 1);

    await voiceActions.leaveVoice();

    expect(remote.callsTo('voice.leave')).toHaveLength(1);
    expect(home.callsTo('voice.leave')).toHaveLength(0);
  });

  test('the pin is cleared with the session', async () => {
    browse(PEER, 9);
    await voiceActions.joinVoice(500);
    expect(testStore.getState().server.voiceInstanceDomain).toBe(PEER);

    await voiceActions.leaveVoice();

    expect(testStore.getState().server.voiceInstanceDomain).toBeUndefined();
  });

  test('a hop from a federated channel to a home channel re-pins to home', async () => {
    browse(PEER, 9);
    await voiceActions.joinVoice(500);

    browse(null, 1);
    await voiceActions.joinVoice(42);

    // The hop left the federated session on ITS instance …
    expect(remote.callsTo('voice.leave')).toHaveLength(1);
    expect(home.callsTo('voice.leave')).toHaveLength(0);
    // … and the new session is pinned to home.
    expect(home.callsTo('voice.join')).toHaveLength(1);
    expect(testStore.getState().server.voiceInstanceDomain).toBeUndefined();
    expect(testStore.getState().server.currentVoiceChannelId).toBe(42);
  });

  test('a restore joins the instance it is told to and keeps the hosting server identity', async () => {
    // Browsing home; the session to restore lived on the peer.
    browse(null, 1);

    await voiceActions.joinVoice(500, {
      instanceDomain: PEER,
      server: { id: 9, publicId: `srv-${PEER}-9` }
    });

    expect(remote.callsTo('voice.join')).toHaveLength(1);
    expect(home.callsTo('voice.join')).toHaveLength(0);
    const { server } = testStore.getState();
    expect(server.voiceInstanceDomain).toBe(PEER);
    expect(server.currentVoiceServerId).toBe(9);
    expect(server.currentVoiceServerPublicId).toBe(`srv-${PEER}-9`);
  });

  test('a pinned instance that is down makes the leave a local-only clear', async () => {
    browse(PEER, 9);
    await voiceActions.joinVoice(500);

    // The peer socket drops.
    restoreClients();
    restoreClients = installClients({ home, remotes: {} });

    await voiceActions.leaveVoice();

    expect(home.callsTo('voice.leave')).toHaveLength(0);
    expect(testStore.getState().server.currentVoiceChannelId).toBeUndefined();
  });
});

describe('DM call pin', () => {
  test('a DM call joins through home, is pinned to home, and leaves through home from a federated server', async () => {
    testStore.dispatch(appSliceActions.setHomeOwnUserId(10));

    const result = await dmActions.joinDmVoiceCall(7);

    expect(result?.routerRtpCapabilities).toEqual(ROUTER_CAPS);
    expect(home.callsTo('dms.voiceJoin')).toHaveLength(1);
    expect(testStore.getState().server.voiceInstanceDomain).toBeUndefined();
    expect(testStore.getState().dms.ownDmCallChannelId).toBe(7);

    browse(PEER, 9);

    await dmActions.leaveDmVoiceCall();

    expect(home.callsTo('dms.voiceLeave')).toHaveLength(1);
    expect(remote.callsTo('dms.voiceLeave')).toHaveLength(0);
    expect(testStore.getState().dms.ownDmCallChannelId).toBeUndefined();
    expect(testStore.getState().server.currentVoiceChannelId).toBeUndefined();
  });
});
