import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onFriendRequestReceivedRoute = userSubscription(
  ServerEvents.FRIEND_REQUEST_RECEIVED
);
const onFriendRequestAcceptedRoute = userSubscription(
  ServerEvents.FRIEND_REQUEST_ACCEPTED
);
const onFriendRequestRejectedRoute = userSubscription(
  ServerEvents.FRIEND_REQUEST_REJECTED
);
const onFriendRemovedRoute = userSubscription(ServerEvents.FRIEND_REMOVED);

export {
  onFriendRemovedRoute,
  onFriendRequestAcceptedRoute,
  onFriendRequestReceivedRoute,
  onFriendRequestRejectedRoute
};
