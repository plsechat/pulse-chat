/**
 * Voice rosters are keyed by `${kind}:${id}`: a DM call and a server
 * voice channel can share a numeric id, and keyed by the bare number the
 * DM call's participants showed up in the server channel's roster while
 * the server channel's permission overrides disabled the DM call's
 * camera/share buttons.
 *
 * Run via:
 *   bun test apps/client/src/features/server/__tests__/voice-kind-keying.test.ts
 */

import { describe, expect, test } from 'bun:test';
import type { TJoinedPublicUser, TVoiceUserState } from '@pulse/shared';
import { appSliceReducer, appSliceActions } from '@/features/app/slice';
import { dmsSliceReducer } from '@/features/dms/slice';
import { friendsSliceReducer } from '@/features/friends/slice';
import { isCurrentVoiceChannelSelectedSelector } from '@/features/server/channels/selectors';
import {
  ownVoiceUserSelector,
  voiceUsersByChannelIdSelector
} from '@/features/server/selectors';
import {
  serverSliceActions,
  serverSliceReducer as reducer,
  type IServerState
} from '@/features/server/slice';
import { hasAnyVoiceUsersSelector } from '@/features/server/voice/selectors';
import type { IRootState } from '@/features/store';

const init = { type: '@@init' };
const voice: TVoiceUserState = {
  micMuted: false,
  soundMuted: false,
  webcamEnabled: false,
  sharingScreen: false,
  serverMuted: false,
  serverDeafened: false
};
const user = (id: number) =>
  ({ id, name: `u${id}`, roleIds: [] }) as unknown as TJoinedPublicUser;

const serverWithChannel5 = (): IServerState => {
  let s = reducer(undefined, init);
  s = reducer(
    s,
    serverSliceActions.setInitialData({
      serverId: 'srv',
      categories: [],
      channels: [
        { id: 5, publicId: 'chan-5', name: 'lounge', type: 'VOICE' } as never
      ],
      ownUserId: 9,
      roles: [],
      channelPermissions: {},
      readStates: {}
    })
  );
  return reducer(s, serverSliceActions.setUsers([user(7), user(8), user(9)]));
};

const root = (server: IServerState, homeOwnUserId?: number): IRootState =>
  ({
    app: appSliceReducer(
      undefined,
      homeOwnUserId === undefined
        ? init
        : appSliceActions.setHomeOwnUserId(homeOwnUserId)
    ),
    server,
    friends: friendsSliceReducer(undefined, init),
    dms: dmsSliceReducer(undefined, init)
  }) as unknown as IRootState;

describe('voice roster keyed by kind', () => {
  test('a DM call participant under dm:5 is not in server channel 5', () => {
    const s = reducer(
      serverWithChannel5(),
      serverSliceActions.addUserToVoiceChannel({
        userId: 8,
        channelId: 5,
        kind: 'dm',
        state: voice
      })
    );
    const state = root(s);
    expect(voiceUsersByChannelIdSelector(state, 5, 'channel')).toEqual([]);
    expect(
      voiceUsersByChannelIdSelector(state, 5, 'dm').map((u) => u.id)
    ).toEqual([8]);
    expect(s.voiceMap).toEqual({ 'dm:5': { users: { 8: voice } } });
  });

  test('remove and update only touch their own kind', () => {
    let s = serverWithChannel5();
    for (const kind of ['channel', 'dm'] as const) {
      s = reducer(
        s,
        serverSliceActions.addUserToVoiceChannel({
          userId: 8,
          channelId: 5,
          kind,
          state: voice,
          startedAt: 100
        })
      );
    }
    s = reducer(
      s,
      serverSliceActions.updateVoiceUserState({
        userId: 8,
        channelId: 5,
        kind: 'dm',
        newState: { micMuted: true }
      })
    );
    expect(s.voiceMap['dm:5']?.users[8]?.micMuted).toBe(true);
    expect(s.voiceMap['channel:5']?.users[8]?.micMuted).toBe(false);

    s = reducer(
      s,
      serverSliceActions.removeUserFromVoiceChannel({
        userId: 8,
        channelId: 5,
        kind: 'dm'
      })
    );
    expect(s.voiceMap['dm:5']).toEqual({ users: {} });
    expect(s.voiceMap['channel:5']).toEqual({
      users: { 8: voice },
      startedAt: 100
    });
  });

  test('the deferred server snapshot is rekeyed and DM entries survive it', () => {
    let s = reducer(
      serverWithChannel5(),
      serverSliceActions.addUserToVoiceChannel({
        userId: 8,
        channelId: 5,
        kind: 'dm',
        state: voice
      })
    );
    s = reducer(
      s,
      serverSliceActions.setDeferredVoiceState({
        voiceMap: { 5: { users: { 7: voice }, startedAt: 42 } },
        externalStreamsMap: {}
      })
    );
    expect(Object.keys(s.voiceMap).sort()).toEqual(['channel:5', 'dm:5']);
    expect(s.voiceMap['channel:5']?.startedAt).toBe(42);
    expect(s.voiceMap['dm:5']?.users[8]).toEqual(voice);
  });

  test('a server switch drops channel rosters but keeps the DM call', () => {
    let s = serverWithChannel5();
    for (const kind of ['channel', 'dm'] as const) {
      s = reducer(
        s,
        serverSliceActions.addUserToVoiceChannel({
          userId: 8,
          channelId: 5,
          kind,
          state: voice
        })
      );
    }
    s = reducer(
      s,
      serverSliceActions.setInitialData({
        serverId: 'other',
        categories: [],
        channels: [],
        ownUserId: 9,
        roles: [],
        channelPermissions: {},
        readStates: {}
      })
    );
    expect(Object.keys(s.voiceMap)).toEqual(['dm:5']);
  });
});

describe('current voice session kind', () => {
  test('a numeric payload is a server channel and captures its publicId', () => {
    const s = reducer(
      serverWithChannel5(),
      serverSliceActions.setCurrentVoiceChannelId(5)
    );
    expect(s.currentVoiceChannelId).toBe(5);
    expect(s.currentVoiceKind).toBe('channel');
    expect(s.currentVoiceChannelPublicId).toBe('chan-5');
  });

  test('a DM call never resolves against the server channel of the same id', () => {
    const s = reducer(
      serverWithChannel5(),
      serverSliceActions.setCurrentVoiceChannelId({ channelId: 5, kind: 'dm' })
    );
    expect(s.currentVoiceChannelId).toBe(5);
    expect(s.currentVoiceKind).toBe('dm');
    expect(s.currentVoiceChannelPublicId).toBeUndefined();

    const selected = reducer(s, serverSliceActions.setSelectedChannelId(5));
    expect(isCurrentVoiceChannelSelectedSelector(root(selected))).toBe(false);
    const inChannel = reducer(
      selected,
      serverSliceActions.setCurrentVoiceChannelId(5)
    );
    expect(isCurrentVoiceChannelSelectedSelector(root(inChannel))).toBe(true);
  });

  test('ending the session clears the kind too', () => {
    let s = reducer(
      serverWithChannel5(),
      serverSliceActions.setCurrentVoiceChannelId({ channelId: 5, kind: 'dm' })
    );
    s = reducer(s, serverSliceActions.setCurrentVoiceChannelId(undefined));
    expect(s.currentVoiceChannelId).toBeUndefined();
    expect(s.currentVoiceKind).toBeUndefined();
  });

  test('the reconnect sweep leaves a DM call alone', () => {
    let s = reducer(
      serverWithChannel5(),
      serverSliceActions.setCurrentVoiceChannelId({ channelId: 5, kind: 'dm' })
    );
    s = { ...s, currentVoiceServerPublicId: 'srv' };
    s = reducer(
      s,
      serverSliceActions.setDeferredVoiceState({
        voiceMap: {},
        externalStreamsMap: {}
      })
    );
    expect(s.currentVoiceChannelId).toBe(5);
    expect(s.currentVoiceKind).toBe('dm');
  });

  test('own voice user resolves by the home id in a DM call', () => {
    let s = reducer(
      serverWithChannel5(),
      serverSliceActions.setCurrentVoiceChannelId({ channelId: 5, kind: 'dm' })
    );
    s = reducer(
      s,
      serverSliceActions.addUserToVoiceChannel({
        userId: 7,
        channelId: 5,
        kind: 'dm',
        state: { ...voice, micMuted: true }
      })
    );
    // Home id 7, ambient (server) id 9.
    expect(ownVoiceUserSelector(root(s, 7))?.state.micMuted).toBe(true);
    expect(ownVoiceUserSelector(root(s))).toBeUndefined();
  });
});

describe('hasAnyVoiceUsersSelector', () => {
  test('counts the active server channels only — not DM calls, not other servers', () => {
    let s = serverWithChannel5();
    s = reducer(
      s,
      serverSliceActions.addUserToVoiceChannel({
        userId: 8,
        channelId: 5,
        kind: 'dm',
        state: voice
      })
    );
    s = reducer(
      s,
      serverSliceActions.addUserToVoiceChannel({
        userId: 8,
        channelId: 77,
        kind: 'channel',
        state: voice
      })
    );
    expect(hasAnyVoiceUsersSelector(root(s))).toBe(false);

    s = reducer(
      s,
      serverSliceActions.addUserToVoiceChannel({
        userId: 8,
        channelId: 5,
        kind: 'channel',
        state: voice
      })
    );
    expect(hasAnyVoiceUsersSelector(root(s))).toBe(true);
  });
});
