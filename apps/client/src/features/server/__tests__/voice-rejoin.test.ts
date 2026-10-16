/**
 * Reconnect mid-call: the server evicts the voice session on socket
 * close; the client re-joins it once the socket is back.
 *
 *  - the session to restore is read off the client's own state (a
 *    Disconnect during the outage leaves nothing to restore)
 *  - a server-channel session is re-joined on its pinned instance and
 *    the provider is asked to rebuild media
 *  - a DM call is re-joined through home
 *  - a refused rejoin clears the local session and says so
 *
 * Run via: bun test apps/client/src/features/server/__tests__/voice-rejoin.test.ts
 */

import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appSliceActions } from '@/features/app/slice';
import { dmsSliceActions } from '@/features/dms/slice';
import { serverSliceActions } from '@/features/server/slice';
import {
  fakeClient,
  federatedEntry,
  installClients,
  installConnectionMocks,
  resetConnectionState,
  testStore,
  type FakeClient
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

const { onAppEvent } = await import('@/lib/events');
const { captureVoiceSession, rejoinVoiceAfterReconnect } = await import(
  '@/features/server/voice/rejoin'
);

const PEER = 'peer.example';
const ROUTER_CAPS = { codecs: [], headerExtensions: [] };

let home: FakeClient;
let remote: FakeClient;
let restoreClients: () => void;
let rejoinEvents: { routerRtpCapabilities: unknown; channelId: number }[];
let offRejoin: () => void;

beforeEach(() => {
  resetConnectionState();
  // The harness reset covers the server slice only; a DM call from an
  // earlier test must not leak into this one.
  testStore.dispatch(dmsSliceActions.setOwnDmCallChannelId(undefined));
  home = fakeClient({
    'voice.join': () => ({ routerRtpCapabilities: ROUTER_CAPS }),
    'dms.voiceJoin': () => ({ routerRtpCapabilities: ROUTER_CAPS })
  });
  remote = fakeClient({
    'voice.join': () => ({ routerRtpCapabilities: ROUTER_CAPS })
  });
  restoreClients = installClients({ home, remotes: { [PEER]: remote } });
  testStore.dispatch(
    appSliceActions.setFederatedServers([federatedEntry(PEER, 9)])
  );
  testStore.dispatch(appSliceActions.setHomeOwnUserId(10));
  rejoinEvents = [];
  offRejoin = onAppEvent('voice-rejoin', (payload) => {
    rejoinEvents.push(payload);
  });
});

afterEach(() => {
  offRejoin();
  restoreClients();
});

describe('captureVoiceSession', () => {
  test('nothing joined → nothing to restore', () => {
    expect(captureVoiceSession(testStore.getState())).toBeUndefined();
  });

  test('a server channel session carries its channel, instance and server', () => {
    testStore.dispatch(serverSliceActions.setVoiceInstanceDomain(PEER));
    testStore.dispatch(serverSliceActions.setCurrentVoiceChannelId(500));
    testStore.dispatch(
      serverSliceActions.setCurrentVoiceServerId({
        id: 9,
        publicId: 'srv-peer-9'
      })
    );

    expect(captureVoiceSession(testStore.getState())).toEqual({
      kind: 'channel',
      channelId: 500,
      instanceDomain: PEER,
      serverId: 9,
      serverPublicId: 'srv-peer-9'
    });
  });

  test('a DM call wins over the server-channel fields it also sets', () => {
    testStore.dispatch(dmsSliceActions.setOwnDmCallChannelId(7));
    testStore.dispatch(
      serverSliceActions.setCurrentVoiceChannelId({ channelId: 7, kind: 'dm' })
    );

    expect(captureVoiceSession(testStore.getState())).toEqual({
      kind: 'dm',
      channelId: 7
    });
  });

  test('a Disconnect during the outage leaves nothing to restore', () => {
    testStore.dispatch(serverSliceActions.setCurrentVoiceChannelId(500));
    testStore.dispatch(serverSliceActions.setCurrentVoiceChannelId(undefined));

    expect(captureVoiceSession(testStore.getState())).toBeUndefined();
  });
});

describe('rejoinVoiceAfterReconnect', () => {
  test('no session → no calls, no event', async () => {
    await rejoinVoiceAfterReconnect(undefined);

    expect(home.calls).toHaveLength(0);
    expect(rejoinEvents).toHaveLength(0);
  });

  test('a server-channel session is re-joined on its pinned instance, even while home is in focus', async () => {
    // The stale ids the fresh snapshots did not get to: still set.
    testStore.dispatch(serverSliceActions.setVoiceInstanceDomain(PEER));
    testStore.dispatch(serverSliceActions.setCurrentVoiceChannelId(500));
    testStore.dispatch(appSliceActions.setActiveInstanceDomain(null));
    testStore.dispatch(appSliceActions.setActiveServerId(1));

    await rejoinVoiceAfterReconnect({
      kind: 'channel',
      channelId: 500,
      instanceDomain: PEER,
      serverId: 9,
      serverPublicId: 'srv-peer-9'
    });

    expect(remote.callsTo('voice.join')).toHaveLength(1);
    expect(remote.callsTo('voice.join')[0]!.input).toMatchObject({
      channelId: 500
    });
    expect(home.callsTo('voice.join')).toHaveLength(0);
    // The stale session was not "left" on any server — it is already gone.
    expect(remote.callsTo('voice.leave')).toHaveLength(0);
    expect(home.callsTo('voice.leave')).toHaveLength(0);

    const { server } = testStore.getState();
    expect(server.currentVoiceChannelId).toBe(500);
    expect(server.voiceInstanceDomain).toBe(PEER);
    expect(server.currentVoiceServerId).toBe(9);
    expect(server.currentVoiceServerPublicId).toBe('srv-peer-9');

    expect(rejoinEvents).toEqual([
      { routerRtpCapabilities: ROUTER_CAPS, channelId: 500 }
    ]);
  });

  test('a DM call is re-joined through home', async () => {
    testStore.dispatch(dmsSliceActions.setOwnDmCallChannelId(7));
    testStore.dispatch(
      serverSliceActions.setCurrentVoiceChannelId({ channelId: 7, kind: 'dm' })
    );

    await rejoinVoiceAfterReconnect({ kind: 'dm', channelId: 7 });

    expect(home.callsTo('dms.voiceJoin')).toHaveLength(1);
    expect(home.callsTo('dms.voiceLeave')).toHaveLength(0);
    expect(testStore.getState().dms.ownDmCallChannelId).toBe(7);
    expect(testStore.getState().server.currentVoiceKind).toBe('dm');
    expect(rejoinEvents).toEqual([
      { routerRtpCapabilities: ROUTER_CAPS, channelId: 7 }
    ]);
  });

  test('a refused rejoin clears the local session and asks for no media', async () => {
    home.handlers['voice.join'] = () => {
      throw new Error('Channel is full');
    };
    testStore.dispatch(serverSliceActions.setCurrentVoiceChannelId(42));

    await rejoinVoiceAfterReconnect({
      kind: 'channel',
      channelId: 42,
      instanceDomain: undefined,
      serverId: 1,
      serverPublicId: 'home-1'
    });

    expect(home.callsTo('voice.join')).toHaveLength(1);
    expect(testStore.getState().server.currentVoiceChannelId).toBeUndefined();
    expect(testStore.getState().server.voiceInstanceDomain).toBeUndefined();
    expect(rejoinEvents).toHaveLength(0);
  });
});
