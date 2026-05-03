import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onDmNewMessageRoute = userSubscription(ServerEvents.DM_NEW_MESSAGE);
const onDmMessageUpdateRoute = userSubscription(ServerEvents.DM_MESSAGE_UPDATE);
const onDmMessageDeleteRoute = userSubscription(ServerEvents.DM_MESSAGE_DELETE);
const onDmCallStartedRoute = userSubscription(ServerEvents.DM_CALL_STARTED);
const onDmCallEndedRoute = userSubscription(ServerEvents.DM_CALL_ENDED);
const onDmCallUserJoinedRoute = userSubscription(
  ServerEvents.DM_CALL_USER_JOINED
);
const onDmCallUserLeftRoute = userSubscription(ServerEvents.DM_CALL_USER_LEFT);
const onDmTypingRoute = userSubscription(ServerEvents.DM_MESSAGE_TYPING);
const onDmChannelUpdateRoute = userSubscription(ServerEvents.DM_CHANNEL_UPDATE);
const onDmChannelDeleteRoute = userSubscription(ServerEvents.DM_CHANNEL_DELETE);
const onDmMemberAddRoute = userSubscription(ServerEvents.DM_MEMBER_ADD);
const onDmMemberRemoveRoute = userSubscription(ServerEvents.DM_MEMBER_REMOVE);

export {
  onDmCallEndedRoute,
  onDmCallStartedRoute,
  onDmCallUserJoinedRoute,
  onDmCallUserLeftRoute,
  onDmChannelDeleteRoute,
  onDmChannelUpdateRoute,
  onDmMemberAddRoute,
  onDmMemberRemoveRoute,
  onDmMessageDeleteRoute,
  onDmMessageUpdateRoute,
  onDmNewMessageRoute,
  onDmTypingRoute
};
