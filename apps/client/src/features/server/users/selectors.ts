import type { IRootState } from '@/features/store';
import { createSelector } from '@reduxjs/toolkit';
import { UserStatus } from '@pulse/shared';
import type { TJoinedPublicUser, TJoinedRole } from '@pulse/shared';
import { createCachedSelector } from 're-reselect';
import { rolesSelector } from '../roles/selectors';

const STATUS_ORDER: Record<string, number> = {
  online: 0,
  idle: 1,
  offline: 2
};

export const ownUserIdSelector = (state: IRootState) => state.server.ownUserId;

/**
 * The user's own id in HOME-instance id-space. state.server.ownUserId
 * is instance-ambient — viewing a federated server overwrites it with
 * the remote shadow id — so any comparison against home-scoped data
 * (DMs, friends, friend requests) must use this. Falls back to the
 * ambient id before the home join completes.
 */
export const homeOwnUserIdSelector = (state: IRootState) =>
  state.app.homeOwnUserId ?? state.server.ownUserId;

export const usersSelector = createSelector(
  (state: IRootState) => state.server.users,
  (users) => {
    return [...users].sort((a, b) => {
      const aBanned = Boolean(a.banned);
      const bBanned = Boolean(b.banned);

      if (aBanned !== bBanned) {
        return aBanned ? 1 : -1;
      }

      const aStatus = STATUS_ORDER[String(a.status ?? UserStatus.OFFLINE)] ?? 3;
      const bStatus = STATUS_ORDER[String(b.status ?? UserStatus.OFFLINE)] ?? 3;

      if (aStatus !== bStatus) {
        return aStatus - bStatus;
      }

      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
  }
);

export const ownUserSelector = createSelector(
  [ownUserIdSelector, usersSelector],
  (ownUserId, users) => users.find((user) => user.id === ownUserId)
);

export const userByIdSelector = createCachedSelector(
  [
    usersSelector,
    (state: IRootState) => state.friends.friends,
    (state: IRootState) => state.dms.channels,
    (_: IRootState, userId: number) => userId
  ],
  (users, friends, dmChannels, userId) =>
    users.find((user) => user.id === userId) ??
    friends.find((friend) => friend.id === userId) ??
    // Non-friend DM partners (e.g. shared-server DMs) exist only in the
    // DM channel member projections — without this fallback they resolve
    // to undefined and every presence surface renders them OFFLINE.
    dmChannels
      .flatMap((channel) => channel.members)
      .find((member) => member.id === userId)
)((_, userId: number) => userId);

export const isOwnUserSelector = createCachedSelector(
  [ownUserIdSelector, (_: IRootState, userId: number) => userId],
  (ownUserId, userId) => ownUserId === userId
)((_, userId: number) => userId);

export const ownPublicUserSelector = createSelector(
  [ownUserIdSelector, usersSelector],
  (ownUserId, users) => users.find((user) => user.id === ownUserId)
);

export const userStatusSelector = createSelector(
  [userByIdSelector],
  (user) => user?.status ?? UserStatus.OFFLINE
);

export const usernamesSelector = createSelector([usersSelector], (users) => {
  const map: Record<number, string> = {};

  users.forEach((user) => {
    map[user.id] = user.name;
  });

  return map;
});

export type TRoleGroup = {
  role: TJoinedRole | null;
  users: TJoinedPublicUser[];
};

export const usersGroupedByRoleSelector = createSelector(
  [usersSelector, rolesSelector],
  (users, roles) => {
    const displayRoles = roles
      .filter((r) => !r.isDefault && !r.isPersistent)
      .sort((a, b) => a.id - b.id);

    const groups: TRoleGroup[] = [];
    const offlineUsers: TJoinedPublicUser[] = [];
    const assignedUserIds = new Set<number>();

    // Group online users by their highest-priority display role
    for (const role of displayRoles) {
      const roleUsers = users.filter(
        (u) =>
          !assignedUserIds.has(u.id) &&
          u.roleIds.includes(role.id) &&
          u.status !== UserStatus.OFFLINE &&
          !u.banned
      );

      if (roleUsers.length > 0) {
        groups.push({ role, users: roleUsers });
        roleUsers.forEach((u) => assignedUserIds.add(u.id));
      }
    }

    // Remaining online users without a display role
    const ungroupedOnline = users.filter(
      (u) =>
        !assignedUserIds.has(u.id) &&
        u.status !== UserStatus.OFFLINE &&
        !u.banned
    );

    if (ungroupedOnline.length > 0) {
      groups.push({ role: null, users: ungroupedOnline });
      ungroupedOnline.forEach((u) => assignedUserIds.add(u.id));
    }

    // Offline users
    for (const u of users) {
      if (!assignedUserIds.has(u.id) && !u.banned) {
        offlineUsers.push(u);
      }
    }

    return { groups, offlineUsers };
  }
);
