import { store } from '@/features/store';
import type { TJoinedPublicUser } from '@pulse/shared';
import { serverSliceActions } from '../slice';

export const setUsers = (users: TJoinedPublicUser[]) => {
  store.dispatch(serverSliceActions.setUsers(users));
};

export const addUser = (user: TJoinedPublicUser) => {
  store.dispatch(serverSliceActions.addUser(user));
};

export const removeUser = (userId: number) => {
  store.dispatch(serverSliceActions.removeUser(userId));
};

export const updateUser = (
  userId: number,
  user: Partial<TJoinedPublicUser>
) => {
  store.dispatch(serverSliceActions.updateUser({ userId, user }));
};

export const handleUserJoin = (user: TJoinedPublicUser) => {
  // Only update users already in the current server's member list.
  // Never add — USER_JOIN fires for all co-members across servers,
  // so adding would create ghost entries when viewing a different server.
  updateUser(user.id, user);
};
