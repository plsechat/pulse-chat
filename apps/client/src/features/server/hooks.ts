import { ChannelPermission, Permission } from '@pulse/shared';
import { useCallback } from 'react';
import { useSelector } from 'react-redux';
import type { IRootState } from '../store';
import { useChannelById, useChannelPermissionsById } from './channels/hooks';
import {
  channelMentionCountByIdSelector,
  channelReadStateByIdSelector,
  hasAnyUnreadSelector
} from './channels/selectors';
import { hasAnyVoiceUsersSelector } from './voice/selectors';
import {
  connectedSelector,
  disconnectInfoSelector,
  infoSelector,
  isOwnUserOwnerSelector,
  ownUserRolesSelector,
  ownVoiceUserSelector,
  pluginsEnabledSelector,
  publicServerSettingsSelector,
  reconnectAttemptSelector,
  reconnectingSelector,
  serverNameSelector,
  typingUsersByChannelIdSelector,
  userDisplayRoleSelector,
  userRolesSelector,
  voiceUsersByChannelIdSelector
} from './selectors';

export const useIsConnected = () => useSelector(connectedSelector);


export const useDisconnectInfo = () => useSelector(disconnectInfoSelector);

export const useIsReconnecting = () => useSelector(reconnectingSelector);

export const useReconnectAttempt = () => useSelector(reconnectAttemptSelector);

export const useServerName = () => useSelector(serverNameSelector);

/**
 * The connected server's globally-unique publicId (state.server.serverId).
 * Flips atomically with setInitialData's wholesale slice replacement —
 * use it (not activeInstanceDomain, which flips optimistically BEFORE the
 * remote data lands) to key views that must remount exactly when the new
 * server's data is in place.
 */
export const useConnectedServerPublicId = () =>
  useSelector((state: IRootState) => state.server.serverId);

/**
 * True when the connected user owns the instance's first server — the
 * operator. Gates instance-level federation (the Federation settings tab).
 */
export const useIsInstanceOwner = () =>
  useSelector((state: IRootState) => state.server.isInstanceOwner);

/**
 * Whether the instance owner permits non-owner server owners to mark their
 * own servers federatable.
 */
export const useFederatableServersAllowed = () =>
  useSelector((state: IRootState) => state.server.federatableServersAllowed);

/** True while the slice holds a read-only servers.preview snapshot. */
export const usePreviewMode = () =>
  useSelector((state: IRootState) => state.server.previewMode);

export const usePreviewMeta = () =>
  useSelector((state: IRootState) => state.server.previewMeta);

export const usePublicServerSettings = () =>
  useSelector(publicServerSettingsSelector);

export const useOwnUserRoles = () => useSelector(ownUserRolesSelector);

export const useInfo = () => useSelector(infoSelector);

export const useIsOwnUserOwner = () => useSelector(isOwnUserOwnerSelector);

/** @pendingBatch B9 — gate for the plugins panel mounted in B9 (A8-1) */
export const usePluginsEnabled = () => useSelector(pluginsEnabledSelector);

export const useCan = () => {
  const ownUserRoles = useOwnUserRoles();
  const isOwner = useIsOwnUserOwner();

  // TODO: maybe this can can recieve both Permission and ChannelPermission?
  const can = useCallback(
    (permission: Permission | Permission[]) => {
      if (isOwner) return true;

      const permissionsToCheck = Array.isArray(permission)
        ? permission
        : [permission];

      for (const role of ownUserRoles) {
        for (const perm of role.permissions) {
          if (permissionsToCheck.includes(perm)) {
            return true;
          }
        }
      }

      return false;
    },
    [ownUserRoles, isOwner]
  );

  return can;
};

export const useChannelCan = (channelId: number | undefined) => {
  const ownUserRoles = useChannelPermissionsById(channelId || -1);
  const isOwner = useIsOwnUserOwner();
  const channel = useChannelById(channelId || -1);

  const can = useCallback(
    (permission: ChannelPermission) => {
      // Overrides apply to public channels too (server evaluates them for
      // every channel); only the owner and an unknown channel short-circuit.
      if (isOwner || !channel) return true;

      // No entry in the permission map (a preview snapshot, or a channel
      // created after the map was built): the server's default applies —
      // public channels allow, private ones deny.
      // (The selector hands back an empty default object, not undefined.)
      if (!ownUserRoles?.permissions) return !channel.private;

      // if VIEW is false, no other permission matters
      if (ownUserRoles.permissions[ChannelPermission.VIEW_CHANNEL] === false)
        return false;

      return ownUserRoles.permissions[permission] === true;
    },
    [ownUserRoles, isOwner, channel]
  );

  return can;
};

export const useUserRoles = (userId: number) =>
  useSelector((state: IRootState) => userRolesSelector(state, userId));

export const useUserDisplayRole = (userId: number) =>
  useSelector((state: IRootState) => userDisplayRoleSelector(state, userId));

export const useTypingUsersByChannelId = (channelId: number) =>
  useSelector((state: IRootState) =>
    typingUsersByChannelIdSelector(state, channelId)
  );

export const useVoiceUsersByChannelId = (channelId: number) =>
  useSelector((state: IRootState) =>
    voiceUsersByChannelIdSelector(state, channelId)
  );

export const useOwnVoiceUser = () => useSelector(ownVoiceUserSelector);

export const useUnreadMessagesCount = (channelId: number) =>
  useSelector((state: IRootState) =>
    channelReadStateByIdSelector(state, channelId)
  );

export const useMentionCount = (channelId: number) =>
  useSelector((state: IRootState) =>
    channelMentionCountByIdSelector(state, channelId)
  );

/** @pendingBatch B7 — wired into the tab/dock badge total in B7 (A7-11) */
export const useHasAnyUnread = () => useSelector(hasAnyUnreadSelector);

export const useHasAnyVoiceUsers = () => useSelector(hasAnyVoiceUsersSelector);
