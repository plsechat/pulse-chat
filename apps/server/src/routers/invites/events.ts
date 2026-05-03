import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onInviteCreateRoute = userSubscription(ServerEvents.INVITE_CREATE);
const onInviteDeleteRoute = userSubscription(ServerEvents.INVITE_DELETE);

export { onInviteCreateRoute, onInviteDeleteRoute };
