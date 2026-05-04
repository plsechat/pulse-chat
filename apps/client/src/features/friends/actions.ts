import { getHomeTRPCClient } from '@/lib/trpc';
import type { TJoinedFriendRequest, TJoinedPublicUser } from '@pulse/shared';
import { store } from '../store';
import { friendsSliceActions } from './slice';

export const setFriends = (friends: TJoinedPublicUser[]) =>
  store.dispatch(friendsSliceActions.setFriends(friends));

export const addFriend = (friend: TJoinedPublicUser) =>
  store.dispatch(friendsSliceActions.addFriend(friend));

export const removeFriend = (userId: number) =>
  store.dispatch(friendsSliceActions.removeFriend(userId));

export const updateFriend = (
  userId: number,
  data: Partial<TJoinedPublicUser>
) => store.dispatch(friendsSliceActions.updateFriend({ userId, data }));

export const setRequests = (requests: TJoinedFriendRequest[]) =>
  store.dispatch(friendsSliceActions.setRequests(requests));

export const addRequest = (request: TJoinedFriendRequest) =>
  store.dispatch(friendsSliceActions.addRequest(request));

export const removeRequest = (requestId: number) =>
  store.dispatch(friendsSliceActions.removeRequest(requestId));

export const setFriendsLoading = (loading: boolean) =>
  store.dispatch(friendsSliceActions.setLoading(loading));

export const resetFriendsState = () =>
  store.dispatch(friendsSliceActions.resetState());

export const fetchFriends = async () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  setFriendsLoading(true);
  try {
    const friends = await trpc.friends.getAll.query();
    setFriends(friends);
  } catch (err) {
    console.error('Failed to fetch friends:', err);
  } finally {
    setFriendsLoading(false);
  }
};

export const fetchFriendRequests = async () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  try {
    const requests = await trpc.friends.getRequests.query();
    setRequests(requests);
  } catch (err) {
    console.error('Failed to fetch friend requests:', err);
  }
};

export const sendFriendRequest = async (userId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.friends.sendRequest.mutate({ userId });
};

export const acceptFriendRequest = async (requestId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.friends.acceptRequest.mutate({ requestId });
};

export const rejectFriendRequest = async (requestId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.friends.rejectRequest.mutate({ requestId });
};

export const removeFriendAction = async (userId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.friends.remove.mutate({ userId });
};

export const setBlockedUsers = (users: TJoinedPublicUser[]) =>
  store.dispatch(friendsSliceActions.setBlocked(users));

export const addBlockedUser = (user: TJoinedPublicUser) =>
  store.dispatch(friendsSliceActions.addBlocked(user));

export const removeBlockedUser = (userId: number) =>
  store.dispatch(friendsSliceActions.removeBlocked(userId));

export const fetchBlockedUsers = async () => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  try {
    const blocked = await trpc.blocks.getBlocked.query();
    setBlockedUsers(blocked);
  } catch (err) {
    console.error('Failed to fetch blocked users:', err);
  }
};

export const blockUser = async (userId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.blocks.block.mutate({ userId });
  // The server fires USER_BLOCK_CHANGED to the blocker; the subscription
  // handler refetches the canonical list. Returning here lets the caller
  // surface a toast immediately without waiting for the round-trip.
};

export const unblockUser = async (userId: number) => {
  const trpc = getHomeTRPCClient();
  if (!trpc) return;
  await trpc.blocks.unblock.mutate({ userId });
};
