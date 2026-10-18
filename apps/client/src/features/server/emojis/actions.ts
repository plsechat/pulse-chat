import { store } from '@/features/store';
import type { TJoinedEmoji } from '@pulse/server/types';
import { serverSliceActions } from '../slice';


export const addEmoji = (emoji: TJoinedEmoji) => {
  store.dispatch(serverSliceActions.addEmoji(emoji));
};

export const updateEmoji = (emojiId: number, emoji: Partial<TJoinedEmoji>) => {
  store.dispatch(serverSliceActions.updateEmoji({ emojiId, emoji }));
};

export const removeEmoji = (emojiId: number) => {
  store.dispatch(serverSliceActions.removeEmoji({ emojiId }));
};
