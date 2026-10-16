import { fetchDmChannels } from '@/features/dms/actions';
import { homeOwnUserIdSelector } from '@/features/server/users/selectors';
import type { IRootState } from '@/features/store';
import { store } from '@/features/store';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getHomeTRPCClient } from '@/lib/trpc';
import type { TJoinedFriendRequest } from '@pulse/shared';
import {
  addFriend,
  addRequest,
  fetchBlockedUsers,
  removeFriend,
  removeRequest
} from './actions';

/**
 * Friend rows are HOME-instance data. `state.server.ownUserId` is the
 * ambient id and holds the remote shadow id while a federated server is
 * active, so comparing against it there picked the wrong side of the
 * request (yourself, when the ids collide). Always resolve "which side
 * is me" against the home id.
 */
const resolveAcceptedFriend = (
  request: TJoinedFriendRequest,
  state: IRootState
) =>
  request.senderId === homeOwnUserIdSelector(state)
    ? request.receiver
    : request.sender;

const resolveRemovedFriendId = (
  data: { userId: number; friendId: number },
  state: IRootState
) => (data.userId === homeOwnUserIdSelector(state) ? data.friendId : data.userId);

const subscribeToFriends = () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onFriendRequestReceived', trpc.friends.onRequestReceived, (request) =>
      addRequest(request)
    ),
    subscribe('onFriendRequestAccepted', trpc.friends.onRequestAccepted, (request) => {
      addFriend(resolveAcceptedFriend(request, store.getState()));
      removeRequest(request.id);
      // Refresh DM channels so the new conversation appears
      fetchDmChannels();
    }),
    subscribe('onFriendRequestRejected', trpc.friends.onRequestRejected, (request) =>
      removeRequest(request.id)
    ),
    subscribe('onFriendRemoved', trpc.friends.onRemoved, (data) => {
      removeFriend(resolveRemovedFriendId(data, store.getState()));
    }),
    // The block events stream is mounted alongside friends because the
    // two state machines are coupled (block → drop friendship + reject
    // pending request) and the UI surfaces are colocated.
    subscribe('onBlockChanged', trpc.blocks.onBlockChanged, () => {
      // Always refetch the canonical list rather than tracking add/remove
      // separately — block lists are tiny and the refetch keeps the
      // friends slice and the blocked list in sync after a block tears
      // down a friendship.
      fetchBlockedUsers();
    })
  );
};

const __testing = { resolveAcceptedFriend, resolveRemovedFriendId };

export { __testing, subscribeToFriends };
