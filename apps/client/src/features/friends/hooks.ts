import { useSelector } from 'react-redux';
import { useMemo } from 'react';
import { ownUserIdSelector } from '../server/users/selectors';
import {
  blockedUsersSelector,
  friendRequestsSelector,
  friendsLoadingSelector,
  friendsSelector
} from './selectors';

export const useFriends = () => useSelector(friendsSelector);

export const useFriendRequests = () => useSelector(friendRequestsSelector);

export const useFriendsLoading = () => useSelector(friendsLoadingSelector);

export const useBlockedUsers = () => useSelector(blockedUsersSelector);

/** Whether the current user has blocked this target user. */
export const useIsUserBlocked = (userId: number | undefined) => {
  const blocked = useBlockedUsers();
  return useMemo(
    () => (userId == null ? false : blocked.some((b) => b.id === userId)),
    [blocked, userId]
  );
};

/**
 * Count of pending requests addressed TO the current user.
 *
 * The friends slice holds every pending row — incoming and outgoing —
 * because the Friends panel surfaces both. The home/server-strip badges
 * should only ever show *incoming* requests; counting the raw list
 * inflates the badge by every outgoing request the user has sent.
 */
export const useIncomingFriendRequestCount = () => {
  const ownUserId = useSelector(ownUserIdSelector);
  const requests = useSelector(friendRequestsSelector);
  if (ownUserId == null) return 0;
  return requests.filter((r) => r.receiverId === ownUserId).length;
};
