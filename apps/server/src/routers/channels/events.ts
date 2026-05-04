import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onChannelCreateRoute = userSubscription(ServerEvents.CHANNEL_CREATE);
const onChannelDeleteRoute = userSubscription(ServerEvents.CHANNEL_DELETE);
const onChannelUpdateRoute = userSubscription(ServerEvents.CHANNEL_UPDATE);
const onChannelPermissionsUpdateRoute = userSubscription(
  ServerEvents.CHANNEL_PERMISSIONS_UPDATE
);
const onChannelReadStatesUpdateRoute = userSubscription(
  ServerEvents.CHANNEL_READ_STATES_UPDATE
);

export {
  onChannelCreateRoute,
  onChannelDeleteRoute,
  onChannelPermissionsUpdateRoute,
  onChannelReadStatesUpdateRoute,
  onChannelUpdateRoute
};
