import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onUserConnectedRoute = userSubscription(ServerEvents.USER_CONNECTED);
const onUserLeaveRoute = userSubscription(ServerEvents.USER_LEAVE);
const onUserUpdateRoute = userSubscription(ServerEvents.USER_UPDATE);
const onUserCreateRoute = userSubscription(ServerEvents.USER_CREATE);
const onUserDeleteRoute = userSubscription(ServerEvents.USER_DELETE);
const onUserKickedRoute = userSubscription(ServerEvents.USER_KICKED);

export {
  onUserConnectedRoute,
  onUserCreateRoute,
  onUserDeleteRoute,
  onUserKickedRoute,
  onUserLeaveRoute,
  onUserUpdateRoute
};
