import { createSelector } from '@reduxjs/toolkit';
import type { IRootState } from '../store';

const sumCounts = (counts: Record<string, number | undefined>) =>
  Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);

export const appLoadingSelector = (state: IRootState) => state.app.loading;


export const modViewOpenSelector = (state: IRootState) => state.app.modViewOpen;

export const modViewUserIdSelector = (state: IRootState) =>
  state.app.modViewUserId;

export const activeViewSelector = (state: IRootState) => state.app.activeView;

export const joinedServersSelector = (state: IRootState) =>
  state.app.joinedServers;

export const activeServerIdSelector = (state: IRootState) =>
  state.app.activeServerId;

export const federatedServersSelector = (state: IRootState) =>
  state.app.federatedServers;

export const activeInstanceDomainSelector = (state: IRootState) =>
  state.app.activeInstanceDomain;

export const serverUnreadCountsSelector = (state: IRootState) =>
  state.app.serverUnreadCounts;

export const serverMentionCountsSelector = (state: IRootState) =>
  state.app.serverMentionCounts;

export const totalDmUnreadCountSelector = (state: IRootState) =>
  state.dms.channels.reduce((sum, ch) => sum + (ch.unreadCount ?? 0), 0);

export const federatedUnreadCountsSelector = (state: IRootState) =>
  state.app.federatedUnreadCounts;

export const federatedMentionCountsSelector = (state: IRootState) =>
  state.app.federatedMentionCounts;

export const federatedConnectionStatusesSelector = (state: IRootState) =>
  state.app.federatedConnectionStatuses;

/**
 * Everything unread, across every joined and federated server plus DMs —
 * what the tab title and the desktop dock badge show. The per-server
 * counts already include the active server's channels, so the active
 * server's readStatesMap is not added on top (it was, once, and only the
 * active server counted at all).
 */
export const totalUnreadSelector = createSelector(
  [
    serverUnreadCountsSelector,
    federatedUnreadCountsSelector,
    totalDmUnreadCountSelector
  ],
  (serverCounts, federatedCounts, dmUnread) =>
    sumCounts(serverCounts) + sumCounts(federatedCounts) + dmUnread
);
