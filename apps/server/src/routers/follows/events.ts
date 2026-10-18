import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onFollowsUpdateRoute = userSubscription(ServerEvents.CHANNEL_FOLLOWS_UPDATE);

export { onFollowsUpdateRoute };
