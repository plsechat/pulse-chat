import type { IRootState } from '../store';

const DEFAULT_ARRAY: never[] = [];

export const dmChannelsSelector = (state: IRootState) => state.dms.channels;

export const selectedDmChannelIdSelector = (state: IRootState) =>
  state.dms.selectedChannelId;

export const selectedDmChannelSelector = (state: IRootState) => {
  const id = state.dms.selectedChannelId;
  if (!id) return undefined;
  return state.dms.channels.find((c) => c.id === id);
};

export const dmMessagesSelector = (
  state: IRootState,
  dmChannelId: number
) => state.dms.messagesMap[dmChannelId] || DEFAULT_ARRAY;

export const dmsLoadingSelector = (state: IRootState) => state.dms.loading;

export const dmActiveCallsSelector = (state: IRootState) =>
  state.dms.activeCalls;

export const dmCallByChannelIdSelector = (
  state: IRootState,
  dmChannelId: number
) => state.dms.activeCalls[dmChannelId];

export const ownDmCallChannelIdSelector = (state: IRootState) =>
  state.dms.ownDmCallChannelId;

export const dmTypingMapSelector = (state: IRootState) =>
  state.dms.dmTypingMap;

export const dmTypingUsersSelector = (
  state: IRootState,
  dmChannelId: number
) => state.dms.dmTypingMap[dmChannelId] || DEFAULT_ARRAY;

export const ringingCallsSelector = (state: IRootState) =>
  state.dms.ringingCalls;
