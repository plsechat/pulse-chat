import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onCategoryCreateRoute = userSubscription(ServerEvents.CATEGORY_CREATE);
const onCategoryDeleteRoute = userSubscription(ServerEvents.CATEGORY_DELETE);
const onCategoryUpdateRoute = userSubscription(ServerEvents.CATEGORY_UPDATE);

export { onCategoryCreateRoute, onCategoryDeleteRoute, onCategoryUpdateRoute };
