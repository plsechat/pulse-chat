import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onSoundCreateRoute = userSubscription(ServerEvents.SOUND_CREATE);
const onSoundUpdateRoute = userSubscription(ServerEvents.SOUND_UPDATE);
const onSoundDeleteRoute = userSubscription(ServerEvents.SOUND_DELETE);

export { onSoundCreateRoute, onSoundDeleteRoute, onSoundUpdateRoute };
