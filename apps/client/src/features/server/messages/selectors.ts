import type { IRootState } from '@/features/store';

const DEFAULT_ARRAY: never[] = [];

export const typingMapSelector = (state: IRootState) => state.server.typingMap;

export const messagesByChannelIdSelector = (
  state: IRootState,
  channelId: number
) => state.server.messagesMap[channelId] || DEFAULT_ARRAY;
