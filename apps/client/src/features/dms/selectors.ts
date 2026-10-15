import type { IRootState } from '../store';

const DEFAULT_ARRAY: never[] = [];

export const dmChannelsSelector = (state: IRootState) => state.dms.channels;


export const dmMessagesSelector = (
  state: IRootState,
  dmChannelId: number
) => state.dms.messagesMap[dmChannelId] || DEFAULT_ARRAY;


export const dmActiveCallsSelector = (state: IRootState) =>
  state.dms.activeCalls;

export const dmCallByChannelIdSelector = (
  state: IRootState,
  dmChannelId: number
) => state.dms.activeCalls[dmChannelId];

export const ownDmCallChannelIdSelector = (state: IRootState) =>
  state.dms.ownDmCallChannelId;


export const dmTypingUsersSelector = (
  state: IRootState,
  dmChannelId: number
) => state.dms.dmTypingMap[dmChannelId] || DEFAULT_ARRAY;

export const ringingCallsSelector = (state: IRootState) =>
  state.dms.ringingCalls;
