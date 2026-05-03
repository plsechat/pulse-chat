import { useSelector } from 'react-redux';
import { ownUserIdSelector } from '../server/users/selectors';
import {
  friendRequestsSelector,
  friendsLoadingSelector,
  friendsSelector
} from './selectors';

export const useFriends = () => useSelector(friendsSelector);

export const useFriendRequests = () => useSelector(friendRequestsSelector);

export const useFriendsLoading = () => useSelector(friendsLoadingSelector);

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
