import { combineUnsubscribes, subscribe } from '@/lib/subscription-helpers';
import { getTRPCClient } from '@/lib/trpc';
import { addEmoji, removeEmoji, updateEmoji } from './actions';

const subscribeToEmojis = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  return combineUnsubscribes(
    subscribe('onEmojiCreate', trpc.emojis.onCreate, (emoji) =>
      addEmoji(emoji)
    ),
    subscribe('onEmojiDelete', trpc.emojis.onDelete, (emojiId) =>
      removeEmoji(emojiId)
    ),
    subscribe('onEmojiUpdate', trpc.emojis.onUpdate, (emoji) =>
      updateEmoji(emoji.id, emoji)
    )
  );
};

export { subscribeToEmojis };
