import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onEventCreateRoute = userSubscription(ServerEvents.EVENT_CREATE);
const onEventUpdateRoute = userSubscription(ServerEvents.EVENT_UPDATE);
const onEventDeleteRoute = userSubscription(ServerEvents.EVENT_DELETE);
const onEventSignupsUpdateRoute = userSubscription(
  ServerEvents.EVENT_SIGNUPS_UPDATE
);
const onEventReminderRoute = userSubscription(ServerEvents.EVENT_REMINDER);

export {
  onEventCreateRoute,
  onEventDeleteRoute,
  onEventReminderRoute,
  onEventSignupsUpdateRoute,
  onEventUpdateRoute
};
