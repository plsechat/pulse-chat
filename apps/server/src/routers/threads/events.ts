import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onThreadCreateRoute = userSubscription(ServerEvents.THREAD_CREATE);
const onThreadUpdateRoute = userSubscription(ServerEvents.THREAD_UPDATE);
const onThreadDeleteRoute = userSubscription(ServerEvents.THREAD_DELETE);

export { onThreadCreateRoute, onThreadDeleteRoute, onThreadUpdateRoute };
