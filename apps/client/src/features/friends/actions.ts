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
  try {
    const requests = await trpc.friends.getRequests.query();
    setRequests(requests);
  } catch (err) {
    console.error('Failed to fetch friend requests:', err);
  }
};

export const sendFriendRequest = async (userId: number) => {
  const trpc = getHomeTRPCClient();
  await trpc.friends.sendRequest.mutate({ userId });
};

export const acceptFriendRequest = async (requestId: number) => {
  const trpc = getHomeTRPCClient();
  await trpc.friends.acceptRequest.mutate({ requestId });
};

export const rejectFriendRequest = async (requestId: number) => {
  const trpc = getHomeTRPCClient();
  await trpc.friends.rejectRequest.mutate({ requestId });
};

export const removeFriendAction = async (userId: number) => {
  const trpc = getHomeTRPCClient();
  await trpc.friends.remove.mutate({ userId });
};
