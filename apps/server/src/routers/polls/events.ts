import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onPollUpdateRoute = userSubscription(ServerEvents.POLL_UPDATE);

export { onPollUpdateRoute };
