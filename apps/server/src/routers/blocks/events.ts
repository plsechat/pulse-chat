import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onBlockChangedRoute = userSubscription(ServerEvents.USER_BLOCK_CHANGED);

export { onBlockChangedRoute };
