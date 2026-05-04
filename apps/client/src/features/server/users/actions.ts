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

export const handleUserJoin = (
  serverId: number,
  user: TJoinedPublicUser
) => {
  // Only act on JOIN events for the active server. The server-side now
  // includes serverId in the payload, so we can safely add a brand-new
  // member to the slice (previous behaviour silently dropped them, which
  // produced the QA-reported bug where new joiners didn't appear in the
  // user bar until refresh).
  const activeServerId = store.getState().app.activeServerId;
  if (activeServerId !== serverId) {
    // For non-active-server JOINs, nothing to do — the new member's
    // identity will be fetched fresh when the viewer next switches there.
    return;
  }

  const existing = store.getState().server.users.find((u) => u.id === user.id);
  if (existing) {
    updateUser(user.id, user);
  } else {
    addUser(user);
  }
};
