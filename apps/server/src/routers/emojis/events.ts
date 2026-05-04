import { ServerEvents } from '@pulse/shared';
import { userSubscription } from '../../utils/trpc';

const onEmojiCreateRoute = userSubscription(ServerEvents.EMOJI_CREATE);
const onEmojiDeleteRoute = userSubscription(ServerEvents.EMOJI_DELETE);
const onEmojiUpdateRoute = userSubscription(ServerEvents.EMOJI_UPDATE);

export { onEmojiCreateRoute, onEmojiDeleteRoute, onEmojiUpdateRoute };
