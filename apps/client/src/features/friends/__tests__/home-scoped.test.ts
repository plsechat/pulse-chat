/**
 * Friends / DMs are HOME-instance data: their mutations must go to the
 * home client and fail loudly when it is gone, and "which side is me"
 * must be decided against the home id even while a federated server
 * (with its own ambient ownUserId) is active.
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as trpcModule from '@/lib/trpc';
import {
  NotConnectedError,
  requireHomeTRPCClient
} from '@/lib/not-connected-error';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { sendFriendRequest } from '@/features/friends/actions';
import { leaveDmChannel, sendDmMessage } from '@/features/dms/actions';
import { __testing as friendSubs } from '@/features/friends/subscriptions';
import { store } from '@/features/store';
import { appSliceActions } from '@/features/app/slice';
import { serverSliceActions } from '@/features/server/slice';
import { UserStatus } from '@pulse/shared';
import type { TJoinedFriendRequest, TJoinedPublicUser } from '@pulse/shared';

const user = (id: number, name: string) =>
  ({ id, name, roleIds: [] }) as unknown as TJoinedPublicUser;

type Recorded = { route: string; input: unknown }[];
/** A client stub whose every `x.y.mutate(input)` is recorded. */
const recordingClient = (calls: Recorded) => {
  const make = (path: string[]): unknown =>
    new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'mutate' || prop === 'query') {
          return async (input: unknown) => {
            calls.push({ route: path.join('.'), input });
            return undefined;
          };
        }
        if (prop === 'then') return undefined;
        return make([...path, String(prop)]);
      }
    });
  return make([]) as never;
};

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  store.dispatch(appSliceActions.setActiveInstanceDomain(null));
  store.dispatch(appSliceActions.setHomeOwnUserId(undefined));
  store.dispatch(serverSliceActions.resetState());
});

describe('home-scoped mutations without a home client', () => {
  test('friend and DM mutation wrappers reject with NotConnectedError', async () => {
    spies.push(spyOn(trpcModule, 'getHomeTRPCClient').mockReturnValue(null));

    await expect(sendFriendRequest(5)).rejects.toBeInstanceOf(NotConnectedError);
    await expect(leaveDmChannel(1)).rejects.toBeInstanceOf(NotConnectedError);
    await expect(sendDmMessage(1, 'hi')).rejects.toBeInstanceOf(
      NotConnectedError
    );
  });

  test('the rejection carries the message the callers toast', async () => {
    spies.push(spyOn(trpcModule, 'getHomeTRPCClient').mockReturnValue(null));
    let caught: unknown;
    try {
      await sendFriendRequest(5);
    } catch (err) {
      caught = err;
    }
    expect(getTrpcError(caught, 'fallback')).toBe(
      'Not connected — try again in a moment'
    );
  });
});

describe('status mutations while a federated server is active', () => {
  test('go to the HOME client, not the active-instance client', async () => {
    const home: Recorded = [];
    const remote: Recorded = [];
    spies.push(
      spyOn(trpcModule, 'getHomeTRPCClient').mockReturnValue(
        recordingClient(home)
      ),
      spyOn(trpcModule, 'getTRPCClient').mockReturnValue(
        recordingClient(remote)
      )
    );
    store.dispatch(appSliceActions.setActiveInstanceDomain('peer'));

    // What user-control's handleStatusChange now does.
    await requireHomeTRPCClient().users.setStatus.mutate({
      status: UserStatus.IDLE
    });

    expect(home).toEqual([
      { route: 'users.setStatus', input: { status: UserStatus.IDLE } }
    ]);
    expect(remote).toEqual([]);
  });
});

describe('friend events resolve "me" against the home id', () => {
  const seed = () => {
    store.dispatch(appSliceActions.setHomeOwnUserId(7));
    // Viewing a federated server: ambient ownUserId is the remote shadow id.
    store.dispatch(
      serverSliceActions.setInitialData({
        serverId: 'remote-srv',
        categories: [],
        channels: [],
        ownUserId: 3,
        roles: [],
        channelPermissions: {},
        readStates: {}
      })
    );
    store.dispatch(appSliceActions.setActiveInstanceDomain('peer'));
  };

  test('accepted request {senderId: 3, receiverId: 7} adds the SENDER', () => {
    seed();
    const request = {
      id: 1,
      senderId: 3,
      receiverId: 7,
      sender: user(3, 'sender'),
      receiver: user(7, 'me')
    } as unknown as TJoinedFriendRequest;

    expect(friendSubs.resolveAcceptedFriend(request, store.getState()).id).toBe(
      3
    );
  });

  test('a request we sent adds the receiver', () => {
    seed();
    const request = {
      id: 2,
      senderId: 7,
      receiverId: 9,
      sender: user(7, 'me'),
      receiver: user(9, 'them')
    } as unknown as TJoinedFriendRequest;

    expect(friendSubs.resolveAcceptedFriend(request, store.getState()).id).toBe(
      9
    );
  });

  test('friend removed picks the other party by the home id', () => {
    seed();
    const state = store.getState();
    expect(friendSubs.resolveRemovedFriendId({ userId: 7, friendId: 3 }, state)).toBe(3);
    expect(friendSubs.resolveRemovedFriendId({ userId: 3, friendId: 7 }, state)).toBe(3);
  });
});
