/**
 * Parametrised selectors must memoise PER id: with a cache of one, two
 * mounted rows alternating ids recomputed on every store update and
 * handed each row a fresh array — a re-render of every row on every
 * typing/presence dispatch.
 */
import { describe, expect, test } from 'bun:test';
import { UserStatus } from '@pulse/shared';
import type { TJoinedPublicUser, TJoinedRole } from '@pulse/server/types';
import { appSliceReducer } from '@/features/app/slice';
import { dmsSliceReducer } from '@/features/dms/slice';
import { friendsSliceReducer } from '@/features/friends/slice';
import {
  userRolesSelector,
  voiceUsersByChannelIdSelector
} from '@/features/server/selectors';
import { serverSliceActions, serverSliceReducer } from '@/features/server/slice';
import { userStatusSelector } from '@/features/server/users/selectors';
import type { IRootState } from '@/features/store';

const init = { type: '@@init' };
const role = (id: number) =>
  ({ id, name: `r${id}`, isDefault: false, isPersistent: false, permissions: [] }) as unknown as TJoinedRole;
const user = (id: number, roleIds: number[], status: UserStatus = UserStatus.ONLINE) =>
  ({ id, name: `u${id}`, roleIds, status }) as unknown as TJoinedPublicUser;

const buildState = (): IRootState => {
  let server = serverSliceReducer(undefined, init);
  server = serverSliceReducer(
    server,
    serverSliceActions.setInitialData({
      serverId: 'srv',
      categories: [],
      channels: [],
      ownUserId: 1,
      roles: [role(1), role(2)],
      channelPermissions: {},
      readStates: {}
    })
  );
  server = serverSliceReducer(
    server,
    serverSliceActions.setUsers([user(1, [1]), user(2, [1, 2]), user(3, [], UserStatus.OFFLINE)])
  );
  const voice = { micMuted: false, soundMuted: false, webcamEnabled: false, sharingScreen: false, serverMuted: false, serverDeafened: false };
  server = serverSliceReducer(
    server,
    serverSliceActions.addUserToVoiceChannel({ userId: 1, channelId: 10, kind: 'channel', state: voice })
  );
  server = serverSliceReducer(
    server,
    serverSliceActions.addUserToVoiceChannel({ userId: 2, channelId: 11, kind: 'channel', state: voice })
  );
  return {
    app: appSliceReducer(undefined, init),
    server,
    friends: friendsSliceReducer(undefined, init),
    dms: dmsSliceReducer(undefined, init)
  } as unknown as IRootState;
};

describe('per-id memoisation', () => {
  test('userRolesSelector keeps identity per user while ids alternate', () => {
    const state = buildState();
    const a1 = userRolesSelector(state, 1);
    const b1 = userRolesSelector(state, 2);
    const a2 = userRolesSelector(state, 1);
    const b2 = userRolesSelector(state, 2);
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
    expect(a1.map((r) => r.id)).toEqual([1]);
    expect(b1.map((r) => r.id)).toEqual([1, 2]);
  });

  test('voiceUsersByChannelIdSelector keeps identity per channel', () => {
    const state = buildState();
    const c10 = voiceUsersByChannelIdSelector(state, 10, 'channel');
    const c11 = voiceUsersByChannelIdSelector(state, 11, 'channel');
    expect(voiceUsersByChannelIdSelector(state, 10, 'channel')).toBe(c10);
    expect(voiceUsersByChannelIdSelector(state, 11, 'channel')).toBe(c11);
    expect(c10.map((u) => u.id)).toEqual([1]);
    expect(c11.map((u) => u.id)).toEqual([2]);
    expect(voiceUsersByChannelIdSelector(state, 99, 'channel')).toEqual([]);
  });

  test('userStatusSelector resolves each id independently', () => {
    const state = buildState();
    expect(userStatusSelector(state, 1)).toBe(UserStatus.ONLINE);
    expect(userStatusSelector(state, 3)).toBe(UserStatus.OFFLINE);
    expect(userStatusSelector(state, 1)).toBe(UserStatus.ONLINE);
    expect(userStatusSelector(state, 42)).toBe(UserStatus.OFFLINE);
  });

  test('a store update that touches nothing relevant keeps the references', () => {
    const state = buildState();
    const before = userRolesSelector(state, 2);
    const next = {
      ...state,
      server: serverSliceReducer(
        state.server,
        serverSliceActions.addTypingUser({ channelId: 5, userId: 3 })
      )
    } as IRootState;
    expect(userRolesSelector(next, 2)).toBe(before);
  });
});
