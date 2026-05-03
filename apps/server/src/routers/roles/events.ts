import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onRoleCreateRoute = userSubscription(ServerEvents.ROLE_CREATE);
const onRoleDeleteRoute = userSubscription(ServerEvents.ROLE_DELETE);
const onRoleUpdateRoute = userSubscription(ServerEvents.ROLE_UPDATE);

export { onRoleCreateRoute, onRoleDeleteRoute, onRoleUpdateRoute };
