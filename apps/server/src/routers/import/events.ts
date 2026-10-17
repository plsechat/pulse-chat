import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

/** Progress of the caller's own import jobs (publishFor targets the creator). */
const onProgressRoute = userSubscription(ServerEvents.IMPORT_PROGRESS);

export { onProgressRoute };
