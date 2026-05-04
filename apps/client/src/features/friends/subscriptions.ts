import { fetchDmChannels } from '@/features/dms/actions';
import { ownUserIdSelector } from '@/features/server/users/selectors';
import { store } from '@/features/store';
import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getHomeTRPCClient } from '@/lib/trpc';
import {
  addFriend,
  addRequest,
  fetchBlockedUsers,
  removeFriend,
  removeRequest
} from './actions';

const subscribeToFriends = () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onFriendRequestReceived', trpc.friends.onRequestReceived, (request) =>
      addRequest(request)
    ),
    subscribe('onFriendRequestAccepted', trpc.friends.onRequestAccepted, (request) => {
      const ownUserId = ownUserIdSelector(store.getState());
      const friend =
        request.senderId === ownUserId ? request.receiver : request.sender;
      addFriend(friend);
      removeRequest(request.id);
      // Refresh DM channels so the new conversation appears
      fetchDmChannels();
    }),
    subscribe('onFriendRequestRejected', trpc.friends.onRequestRejected, (request) =>
      removeRequest(request.id)
    ),
    subscribe('onFriendRemoved', trpc.friends.onRemoved, (data) => {
      const ownUserId = ownUserIdSelector(store.getState());
      const friendToRemove =
        data.userId === ownUserId ? data.friendId : data.userId;
      removeFriend(friendToRemove);
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

export { subscribeToFriends };
