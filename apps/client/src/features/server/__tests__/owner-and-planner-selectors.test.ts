/**
 * The owner shortcut must agree with the server (utils/wss.ts): the
 * connected server's `ownerId`, or the bootstrap Owner role. Matching
 * the role alone hid "New event" and the Events tab from the owner of
 * every community created after the first one.
 *
 * Run via: bun test apps/client/src/features/server/__tests__/owner-and-planner-selectors.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { OWNER_ROLE_ID } from '@pulse/shared';
import type { TJoinedRole, TPublicServerSettings, TServerSummary } from '@pulse/server/types';
import { appSliceActions, appSliceReducer } from '@/features/app/slice';
import { dmsSliceReducer } from '@/features/dms/slice';
import { friendsSliceReducer } from '@/features/friends/slice';
import {
  isOwnUserOwnerSelector,
  plannerEnabledSelector
} from '@/features/server/selectors';
import { serverSliceActions, serverSliceReducer } from '@/features/server/slice';
import type { IRootState } from '@/features/store';

const init = { type: '@@init' };
const role = (id: number) =>
  ({ id, name: `r${id}`, isDefault: false, isPersistent: false, permissions: [] }) as unknown as TJoinedRole;
const summary = (id: number, ownerId: number | null) =>
  ({ id, name: `s${id}`, publicId: `pid-${id}`, logo: null, ownerId }) as TServerSummary;

type TBuild = {
  ownUserId: number;
  roleIds: number[];
  joined: TServerSummary[];
  activeServerId: number | undefined;
  activeInstanceDomain?: string | null;
  publicSettings?: Partial<TPublicServerSettings>;
};

const buildState = ({
  ownUserId,
  roleIds,
  joined,
  activeServerId,
  activeInstanceDomain = null,
  publicSettings
}: TBuild): IRootState => {
  let app = appSliceReducer(undefined, init);
  app = appSliceReducer(app, appSliceActions.setJoinedServers(joined));
  app = appSliceReducer(app, appSliceActions.setActiveServerId(activeServerId));
  app = appSliceReducer(app, appSliceActions.setActiveInstanceDomain(activeInstanceDomain));

  let server = serverSliceReducer(undefined, init);
  server = serverSliceReducer(
    server,
    serverSliceActions.setInitialData({
      serverId: 'srv',
      categories: [],
      channels: [],
      ownUserId,
      roles: [role(OWNER_ROLE_ID), role(2)],
      channelPermissions: {},
      readStates: {},
      ...(publicSettings ? { publicSettings } : {})
    } as unknown as Parameters<typeof serverSliceActions.setInitialData>[0])
  );
  server = serverSliceReducer(
    server,
    serverSliceActions.setUsers([
      { id: ownUserId, name: 'me', roleIds } as unknown as Parameters<
        typeof serverSliceActions.setUsers
      >[0][number]
    ])
  );

  return {
    app,
    server,
    friends: friendsSliceReducer(undefined, init),
    dms: dmsSliceReducer(undefined, init)
  } as unknown as IRootState;
};

describe('isOwnUserOwnerSelector', () => {
  test('the owner of a later-created community counts without the bootstrap role', () => {
    const state = buildState({
      ownUserId: 5,
      roleIds: [2],
      joined: [summary(1, 1), summary(7, 5)],
      activeServerId: 7
    });
    expect(isOwnUserOwnerSelector(state)).toBe(true);
  });

  test('a member of that community is not its owner', () => {
    const state = buildState({
      ownUserId: 6,
      roleIds: [2],
      joined: [summary(7, 5)],
      activeServerId: 7
    });
    expect(isOwnUserOwnerSelector(state)).toBe(false);
  });

  test('the bootstrap Owner role still counts on the first server (ownerId null)', () => {
    const state = buildState({
      ownUserId: 1,
      roleIds: [OWNER_ROLE_ID],
      joined: [summary(1, null)],
      activeServerId: 1
    });
    expect(isOwnUserOwnerSelector(state)).toBe(true);
  });

  test('a federated connection never matches a home server by id', () => {
    // Home server 7 is ours; the peer's server 7 is someone else's.
    const state = buildState({
      ownUserId: 5,
      roleIds: [2],
      joined: [summary(7, 5)],
      activeServerId: 7,
      activeInstanceDomain: 'peer.example'
    });
    expect(isOwnUserOwnerSelector(state)).toBe(false);
  });

  test('an unknown owner never matches an unknown user', () => {
    const state = buildState({
      ownUserId: undefined as unknown as number,
      roleIds: [],
      joined: [summary(7, null)],
      activeServerId: 7
    });
    expect(isOwnUserOwnerSelector(state)).toBe(false);
  });
});

describe('plannerEnabledSelector', () => {
  test('on by default, including for a server that does not send the flag', () => {
    expect(
      plannerEnabledSelector(
        buildState({ ownUserId: 1, roleIds: [], joined: [], activeServerId: 1 })
      )
    ).toBe(true);
    expect(
      plannerEnabledSelector(
        buildState({
          ownUserId: 1,
          roleIds: [],
          joined: [],
          activeServerId: 1,
          publicSettings: { enableEvents: true }
        })
      )
    ).toBe(true);
  });

  test('off only when the community switched it off', () => {
    expect(
      plannerEnabledSelector(
        buildState({
          ownUserId: 1,
          roleIds: [],
          joined: [],
          activeServerId: 1,
          publicSettings: { enableEvents: false }
        })
      )
    ).toBe(false);
  });
});
