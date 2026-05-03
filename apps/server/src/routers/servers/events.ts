import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onMemberJoinRoute = userSubscription(ServerEvents.SERVER_MEMBER_JOIN);
const onMemberLeaveRoute = userSubscription(ServerEvents.SERVER_MEMBER_LEAVE);
const onUnreadCountUpdateRoute = userSubscription(
  ServerEvents.SERVER_UNREAD_COUNT_UPDATE
);

export { onMemberJoinRoute, onMemberLeaveRoute, onUnreadCountUpdateRoute };
