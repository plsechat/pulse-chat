import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onUserJoinRoute = userSubscription(ServerEvents.USER_JOIN);
const onUserLeaveRoute = userSubscription(ServerEvents.USER_LEAVE);
const onUserUpdateRoute = userSubscription(ServerEvents.USER_UPDATE);
const onUserCreateRoute = userSubscription(ServerEvents.USER_CREATE);
const onUserDeleteRoute = userSubscription(ServerEvents.USER_DELETE);
const onUserKickedRoute = userSubscription(ServerEvents.USER_KICKED);

export {
  onUserCreateRoute,
  onUserDeleteRoute,
  onUserJoinRoute,
  onUserKickedRoute,
  onUserLeaveRoute,
  onUserUpdateRoute
};
