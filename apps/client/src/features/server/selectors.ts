import { createSelector } from '@reduxjs/toolkit';
import { OWNER_ROLE_ID } from '@pulse/shared';
import { createCachedSelector } from 're-reselect';
import type { IRootState } from '../store';
import {
  currentVoiceChannelIdSelector,
  currentVoiceKindSelector
} from './channels/selectors';
import { typingMapSelector } from './messages/selectors';
import { rolesSelector } from './roles/selectors';
import type { TVoiceUser } from './types';
import {
  homeOwnUserIdSelector,
  ownPublicUserSelector,
  ownUserIdSelector,
  userByIdSelector,
  usersSelector
} from './users/selectors';
import { voiceMapKey, type TVoiceKind } from './voice/keys';
import { voiceChannelStateSelector } from './voice/selectors';

export const connectedSelector = (state: IRootState) => state.server.connected;

export const disconnectInfoSelector = (state: IRootState) =>
  state.server.disconnectInfo;


export const reconnectingSelector = (state: IRootState) =>
  state.server.reconnecting;

export const reconnectAttemptSelector = (state: IRootState) =>
  state.server.reconnectAttempt;

export const serverNameSelector = (state: IRootState) =>
  state.server.publicSettings?.name;


export const publicServerSettingsSelector = (state: IRootState) =>
  state.server.publicSettings;

export const pluginsEnabledSelector = (state: IRootState) =>
  !!state.server.publicSettings?.enablePlugins;

export const infoSelector = (state: IRootState) => state.server.info;

export const ownUserRolesSelector = createSelector(
  [ownPublicUserSelector, rolesSelector],
  (ownUser, roles) => {
    if (!ownUser?.roleIds) return [];
    return roles.filter((role) => ownUser.roleIds.includes(role.id));
  }
);

export const isOwnUserOwnerSelector = createSelector(
  [ownUserRolesSelector],
  (ownUserRoles) => ownUserRoles.some((role) => role.id === OWNER_ROLE_ID)
);

// Keyed by id: a plain createSelector memoises only the LAST (state, id)
// pair, so with several rows mounted every store update handed each one
// a fresh array and re-rendered the whole table on unrelated dispatches.
export const userRolesSelector = createCachedSelector(
  [rolesSelector, userByIdSelector],
  (roles, user) => {
    if (!user?.roleIds) return [];
    return roles.filter((role) => user.roleIds.includes(role.id));
  }
)((_: IRootState, userId: number) => userId);

export const userDisplayRoleSelector = createCachedSelector(
  [rolesSelector, userByIdSelector],
  (roles, user) => {
    if (!user?.roleIds) return undefined;
    // Find the first non-default, non-persistent role (lowest id = highest priority)
    const displayRole = roles
      .filter(
        (role) =>
          user.roleIds.includes(role.id) && !role.isDefault && !role.isPersistent
      )
      .sort((a, b) => a.id - b.id)[0];
    return displayRole;
  }
)((_: IRootState, userId: number) => userId);


export const typingUsersByChannelIdSelector = createCachedSelector(
  [
    typingMapSelector,
    (_: IRootState, channelId: number) => channelId,
    ownUserIdSelector,
    usersSelector
  ],
  (typingMap, channelId, ownUserId, users) => {
    const userIds = typingMap[channelId] || [];

    return userIds
      .filter((id) => id !== ownUserId)
      .map((id) => users.find((u) => u.id === id)!)
      .filter((u) => !!u);
  }
)((_, channelId: number) => channelId);

export const voiceUsersByChannelIdSelector = createCachedSelector(
  [usersSelector, voiceChannelStateSelector],
  (users, voiceState) => {
    const voiceUsers: TVoiceUser[] = [];

    if (!voiceState) return voiceUsers;

    Object.entries(voiceState.users).forEach(([userIdStr, state]) => {
      const userId = Number(userIdStr);
      const user = users.find((u) => u.id === userId);

      if (user) {
        voiceUsers.push({
          ...user,
          state
        });
      }
    });

    return voiceUsers;
  }
)((_: IRootState, channelId: number, kind: TVoiceKind) =>
  voiceMapKey(kind, channelId)
);

export const ownVoiceUserSelector = createSelector(
  [
    // A DM call's participants are home-account ids; a server channel's
    // are the ambient (possibly remote shadow) ids.
    (state: IRootState) =>
      currentVoiceKindSelector(state) === 'dm'
        ? homeOwnUserIdSelector(state)
        : ownUserIdSelector(state),
    (state: IRootState) => {
      const channelId = currentVoiceChannelIdSelector(state);
      const kind = currentVoiceKindSelector(state);

      if (channelId === undefined || kind === undefined) return undefined;

      return voiceUsersByChannelIdSelector(state, channelId, kind);
    }
  ],
  (ownUserId, voiceUsers) =>
    voiceUsers?.find((voiceUser) => voiceUser.id === ownUserId)
);
