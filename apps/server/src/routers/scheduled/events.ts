import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onScheduledPostUpdateRoute = userSubscription(ServerEvents.SCHEDULED_POST_UPDATE);

export { onScheduledPostUpdateRoute };
