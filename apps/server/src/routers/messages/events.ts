import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onMessageDeleteRoute = userSubscription(ServerEvents.MESSAGE_DELETE);
const onMessageBulkDeleteRoute = userSubscription(ServerEvents.MESSAGE_BULK_DELETE);
const onMessageUpdateRoute = userSubscription(ServerEvents.MESSAGE_UPDATE);
const onMessageRoute = userSubscription(ServerEvents.NEW_MESSAGE);
const onMessageTypingRoute = userSubscription(ServerEvents.MESSAGE_TYPING);
const onMessagePinRoute = userSubscription(ServerEvents.MESSAGE_PIN);
const onMessageUnpinRoute = userSubscription(ServerEvents.MESSAGE_UNPIN);

export {
  onMessageBulkDeleteRoute,
  onMessageDeleteRoute,
  onMessagePinRoute,
  onMessageRoute,
  onMessageTypingRoute,
  onMessageUnpinRoute,
  onMessageUpdateRoute
};
