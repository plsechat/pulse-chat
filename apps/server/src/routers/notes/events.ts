import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onNoteUpdateRoute = userSubscription(ServerEvents.USER_NOTE_UPDATE);

export { onNoteUpdateRoute };
