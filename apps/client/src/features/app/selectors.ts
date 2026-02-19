import type { IRootState } from '../store';

export const appLoadingSelector = (state: IRootState) => state.app.loading;

export const devicesSelector = (state: IRootState) => state.app.devices;

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
