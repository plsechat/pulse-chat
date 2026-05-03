import { getTRPCClient } from '@/lib/trpc';
import type { TJoinedEmoji } from '@pulse/shared';
import { addEmoji, removeEmoji, updateEmoji } from './actions';

const subscribeToEmojis = () => {
  const trpc = getTRPCClient();
  if (!trpc) return () => {};

  const onEmojiCreateSub = trpc.emojis.onCreate.subscribe(undefined, {
    onData: (emoji: TJoinedEmoji) => addEmoji(emoji),
    onError: (err) => console.error('onEmojiCreate subscription error:', err)
  });

  const onEmojiDeleteSub = trpc.emojis.onDelete.subscribe(undefined, {
    onData: (emojiId: number) => removeEmoji(emojiId),
    onError: (err) => console.error('onEmojiDelete subscription error:', err)
  });

  const onEmojiUpdateSub = trpc.emojis.onUpdate.subscribe(undefined, {
    onData: (emoji: TJoinedEmoji) => updateEmoji(emoji.id, emoji),
    onError: (err) => console.error('onEmojiUpdate subscription error:', err)
  });

  return () => {
    onEmojiCreateSub.unsubscribe();
    onEmojiDeleteSub.unsubscribe();
    onEmojiUpdateSub.unsubscribe();
  };
};

export { subscribeToEmojis };
