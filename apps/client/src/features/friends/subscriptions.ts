import { getHomeTRPCClient } from '@/lib/trpc';
import { ownUserIdSelector } from '@/features/server/users/selectors';
import { store } from '@/features/store';
import type { TJoinedFriendRequest } from '@pulse/shared';
import {
  addFriend,
  addRequest,
  removeFriend,
  removeRequest
} from './actions';
import { fetchDmChannels } from '@/features/dms/actions';

const subscribeToFriends = () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return () => {};

  const onRequestReceivedSub = trpc.friends.onRequestReceived.subscribe(
    undefined,
    {
      onData: (request: TJoinedFriendRequest) => addRequest(request),
      onError: (err) =>
        console.error('onFriendRequestReceived subscription error:', err)
    }
  );

  const onRequestAcceptedSub = trpc.friends.onRequestAccepted.subscribe(
    undefined,
    {
      onData: (request: TJoinedFriendRequest) => {
        const ownUserId = ownUserIdSelector(store.getState());
        const friend =
          request.senderId === ownUserId ? request.receiver : request.sender;
        addFriend(friend);
        removeRequest(request.id);
        // Refresh DM channels so the new conversation appears
        fetchDmChannels();
      },
      onError: (err) =>
        console.error('onFriendRequestAccepted subscription error:', err)
    }
  );

  const onRequestRejectedSub = trpc.friends.onRequestRejected.subscribe(
    undefined,
    {
      onData: (request: TJoinedFriendRequest) =>
        removeRequest(request.id),
      onError: (err) =>
        console.error('onFriendRequestRejected subscription error:', err)
    }
  );

  const onRemovedSub = trpc.friends.onRemoved.subscribe(undefined, {
    onData: (data: { userId: number; friendId: number }) => {
      const ownUserId = ownUserIdSelector(store.getState());
      const friendToRemove =
        data.userId === ownUserId ? data.friendId : data.userId;
      removeFriend(friendToRemove);
    },
    onError: (err) => console.error('onFriendRemoved subscription error:', err)
  });

  return () => {
    onRequestReceivedSub.unsubscribe();
    onRequestAcceptedSub.unsubscribe();
    onRequestRejectedSub.unsubscribe();
    onRemovedSub.unsubscribe();
  };
};

export { subscribeToFriends };
