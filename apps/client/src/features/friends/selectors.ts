import type { IRootState } from '../store';

export const friendsSelector = (state: IRootState) => state.friends.friends;

export const friendRequestsSelector = (state: IRootState) =>
  state.friends.requests;

export const friendsLoadingSelector = (state: IRootState) =>
  state.friends.loading;

export const blockedUsersSelector = (state: IRootState) =>
  state.friends.blocked;
