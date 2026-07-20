import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { Slider } from '@/components/ui/slider';
import { ServerScreen } from '@/components/server-screens/screens';
import { setModViewOpen } from '@/features/app/actions';
import { useActiveServerId } from '@/features/app/hooks';
import {
  requestConfirmation,
  requestTextInput
} from '@/features/dialogs/actions';
import {
  getOrCreateDmChannel,
  joinDmVoiceCall,
  navigateToDm
} from '@/features/dms/actions';
import { blockUser, unblockUser } from '@/features/friends/actions';
import { useOwnDmCallChannelId } from '@/features/dms/hooks';
import { useIsUserBlocked } from '@/features/friends/hooks';
import { openServerScreen } from '@/features/server-screens/actions';
import { useCan, useUserRoles } from '@/features/server/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { useRoles } from '@/features/server/roles/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { voiceMapSelector } from '@/features/server/voice/selectors';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { dispatchMentionUser } from '@/lib/events';
import type { IRootState } from '@/features/store';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { Permission } from '@pulse/shared';
import { memo, useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';

type TUserContextMenuProps = {
  children: React.ReactNode;
  userId: number;
};

const UserContextMenu = memo(({ children, userId }: TUserContextMenuProps) => {
  const user = useUserById(userId);
  const ownUserId = useOwnUserId();
  const can = useCan();
  const roles = useRoles();
  const userRoles = useUserRoles(userId);
  const voiceMap = useSelector(voiceMapSelector);
  const activeInstanceDomain = useSelector(
    (state: IRootState) => state.app.activeInstanceDomain
  );
  const { getVolume, setVolume, toggleMute, getUserVolumeKey } =
    useVolumeControl();
  const activeServerId = useActiveServerId();
  const isBlocked = useIsUserBlocked(userId);
  const ownDmCallChannelId = useOwnDmCallChannelId();
  const { init: initVoice } = useVoice();
  const isOwnUser = userId === ownUserId;
  // Mod tools are per-LOCAL-server (same gate as the user popover) — hidden
  // while browsing a federated server or outside any server context.
  const inSharedServer =
    !activeInstanceDomain && activeServerId !== undefined;

  const volumeKey = getUserVolumeKey(userId);
  const currentVolume = getVolume(volumeKey);
  const isMuted = currentVolume === 0;

  const voiceState = useMemo(() => {
    for (const ch of Object.values(voiceMap)) {
      const state = ch?.users[userId];
      if (state) return state;
    }
    return undefined;
  }, [voiceMap, userId]);
  const isInVoice = voiceState !== undefined;

  const userRoleIds = useMemo(
    () => new Set(userRoles.map((r) => r.id)),
    [userRoles]
  );

  const handleMention = useCallback(() => {
    if (user) {
      dispatchMentionUser(user.id, user.name);
    }
  }, [user]);

  // While browsing a federated server, roster ids live in the REMOTE
  // instance's id-space — resolve to a home-side shadow user first (same
  // flow as the user popover). Sending the raw remote numeric id to the
  // home instance's dms.getOrCreateChannel targeted whatever home user
  // happened to share that id.
  const resolveLocalUserId = useCallback(async (): Promise<number | null> => {
    if (!(activeInstanceDomain && user?.publicId)) return userId;
    const trpc = getHomeTRPCClient();
    if (!trpc) return null;
    const result = await trpc.federation.ensureShadowUser.mutate({
      instanceDomain: activeInstanceDomain,
      remoteUserId: userId,
      username: user.name,
      remotePublicId: user.publicId
    });
    return result.localUserId;
  }, [activeInstanceDomain, user, userId]);

  const handleMessage = useCallback(async () => {
    try {
      const localId = await resolveLocalUserId();
      if (localId === null) return;

      const channel = await getOrCreateDmChannel(localId);
      if (channel) {
        // Land on the new DM, not just the home view in general.
        // navigateToDm bridges through HomeView's local state via the
        // dm-navigate CustomEvent — Redux alone doesn't re-render.
        await navigateToDm(channel.id);
      }
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to open DM'));
    }
  }, [resolveLocalUserId]);

  const handleStartCall = useCallback(async () => {
    try {
      const localId = await resolveLocalUserId();
      if (localId === null) return;

      const channel = await getOrCreateDmChannel(localId);
      if (!channel) return;
      await navigateToDm(channel.id);
      const result = await joinDmVoiceCall(channel.id);
      if (result) {
        await initVoice(result.routerRtpCapabilities, channel.id);
      }
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to start call'));
    }
  }, [resolveLocalUserId, initVoice]);

  const handleAddNote = useCallback(async () => {
    const text = await requestTextInput({
      title: 'Add Note',
      message: `Note about ${user?.name ?? 'this user'}`,
      confirmLabel: 'Save',
      cancelLabel: 'Cancel'
    });

    if (text) {
      try {
        const trpc = getTRPCClient();
        if (!trpc) return;
        await trpc.notes.add.mutate({ targetUserId: userId, content: text });
        toast.success('Note saved');
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to save note'));
      }
    }
  }, [userId, user]);

  const handleDisconnectFromVoice = useCallback(async () => {
    try {
      const trpc = getTRPCClient();
      if (!trpc) return;
      await trpc.voice.disconnectUser.mutate({ userId });
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to disconnect user from voice'));
    }
  }, [userId]);

  const handleToggleServerMute = useCallback(async () => {
    try {
      const trpc = getTRPCClient();
      if (!trpc) return;
      await trpc.voice.moderateMember.mutate({
        userId,
        serverMuted: !voiceState?.serverMuted
      });
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update server mute'));
    }
  }, [userId, voiceState?.serverMuted]);

  const handleToggleServerDeafen = useCallback(async () => {
    try {
      const trpc = getTRPCClient();
      if (!trpc) return;
      await trpc.voice.moderateMember.mutate({
        userId,
        serverDeafened: !voiceState?.serverDeafened
      });
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update server deafen'));
    }
  }, [userId, voiceState?.serverDeafened]);

  const handleEditNickname = useCallback(async () => {
    const text = await requestTextInput({
      title: 'Set Nickname',
      message: 'Nickname for this server (leave empty to clear)',
      confirmLabel: 'Save',
      cancelLabel: 'Cancel',
      defaultValue: user?.nickname ?? '',
      allowEmpty: true
    });
    if (text === null || text === undefined) return;
    try {
      const trpc = getTRPCClient();
      if (!trpc) return;
      const nickname = text.trim() || null;
      if (isOwnUser) {
        await trpc.users.setNickname.mutate({ nickname });
      } else {
        await trpc.users.setUserNickname.mutate({ userId, nickname });
      }
      toast.success(nickname ? 'Nickname updated' : 'Nickname cleared');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to update nickname'));
    }
  }, [userId, user?.nickname, isOwnUser]);

  const handleVerifyIdentity = useCallback(() => {
    openServerScreen(ServerScreen.USER_SETTINGS, {
      initialSection: 'verify-identity',
      initialVerifyPeerId: userId
    });
  }, [userId]);

  const handleBlockToggle = useCallback(async () => {
    if (!user) return;
    if (isBlocked) {
      try {
        await unblockUser(userId);
        toast.success(`Unblocked ${user.name}`);
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to unblock user'));
      }
      return;
    }
    const confirmed = await requestConfirmation({
      title: `Block ${user.name}?`,
      message:
        'They will be removed from your friends and will no longer be able to message you.',
      confirmLabel: 'Block'
    });
    if (!confirmed) return;
    try {
      await blockUser(userId);
      toast.success(`Blocked ${user.name}`);
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to block user'));
    }
  }, [isBlocked, user, userId]);

  const handleKick = useCallback(async () => {
    const reason = await requestTextInput({
      title: 'Kick User',
      message: 'Please provide a reason for kicking this user (optional).',
      confirmLabel: 'Kick',
      allowEmpty: true
    });
    if (reason === null) return;
    try {
      const trpc = getTRPCClient();
      if (!trpc) return;
      await trpc.users.kick.mutate({ userId, reason });
      toast.success('User kicked successfully');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to kick user'));
    }
  }, [userId]);

  const handleBan = useCallback(async () => {
    const reason = await requestTextInput({
      title: 'Ban User',
      message: 'Please provide a reason for banning this user (optional).',
      confirmLabel: 'Ban',
      allowEmpty: true
    });
    if (reason === null) return;
    try {
      const trpc = getTRPCClient();
      if (!trpc) return;
      await trpc.users.ban.mutate({ userId, reason });
      toast.success('User banned successfully');
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to ban user'));
    }
  }, [userId]);

  const handleCopyUserId = useCallback(() => {
    if (!user?.publicId) return;
    navigator.clipboard.writeText(user.publicId);
    toast.success('User ID copied');
  }, [user?.publicId]);

  const handleToggleRole = useCallback(
    async (roleId: number, hasRole: boolean) => {
      try {
        const trpc = getTRPCClient();
        if (!trpc) return;
        if (hasRole) {
          await trpc.users.removeRole.mutate({ userId, roleId });
        } else {
          await trpc.users.addRole.mutate({ userId, roleId });
        }
      } catch (err) {
        toast.error(getTrpcError(err, 'Failed to update role'));
      }
    },
    [userId]
  );

  if (!user) return <>{children}</>;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onClick={handleMention}>Mention</ContextMenuItem>
        {!isOwnUser && (
          <>
            <ContextMenuItem onClick={handleMessage}>Message</ContextMenuItem>
            <ContextMenuItem
              onClick={handleStartCall}
              disabled={!!ownDmCallChannelId}
            >
              Start Call
            </ContextMenuItem>
          </>
        )}

        {!isOwnUser && isInVoice && (
          <>
            <ContextMenuSeparator />
            <ContextMenuCheckboxItem
              checked={isMuted}
              onCheckedChange={() => toggleMute(volumeKey)}
            >
              Mute
            </ContextMenuCheckboxItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Volume</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <div className="px-3 py-2 w-40">
                  <Slider
                    value={[currentVolume]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={([val]) => setVolume(volumeKey, val)}
                  />
                  <div className="text-xs text-muted-foreground text-center mt-1">
                    {currentVolume}%
                  </div>
                </div>
              </ContextMenuSubContent>
            </ContextMenuSub>
            {can(Permission.MANAGE_USERS) && (
              <>
                <ContextMenuItem onClick={handleToggleServerMute}>
                  {voiceState?.serverMuted
                    ? 'Unmute (Server)'
                    : 'Server Mute'}
                </ContextMenuItem>
                <ContextMenuItem onClick={handleToggleServerDeafen}>
                  {voiceState?.serverDeafened
                    ? 'Undeafen (Server)'
                    : 'Server Deafen'}
                </ContextMenuItem>
                <ContextMenuItem
                  variant="destructive"
                  onClick={handleDisconnectFromVoice}
                >
                  Disconnect from Voice
                </ContextMenuItem>
              </>
            )}
          </>
        )}

        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleAddNote}>Add Note</ContextMenuItem>
        {(isOwnUser || can(Permission.MANAGE_USERS)) && (
          <ContextMenuItem onClick={handleEditNickname}>
            Change Nickname
          </ContextMenuItem>
        )}

        {!isOwnUser && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={handleVerifyIdentity}>
              Verify Identity
            </ContextMenuItem>
            <ContextMenuItem
              onClick={handleBlockToggle}
              variant={isBlocked ? undefined : 'destructive'}
            >
              {isBlocked ? `Unblock ${user.name}` : `Block ${user.name}`}
            </ContextMenuItem>
          </>
        )}

        {can(Permission.MANAGE_USERS) && roles.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>Roles</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {roles
                  .filter((r) => !(r.isPersistent && !r.isDefault))
                  .map((role) => (
                  <ContextMenuCheckboxItem
                    key={role.id}
                    checked={userRoleIds.has(role.id)}
                    onCheckedChange={() =>
                      handleToggleRole(role.id, userRoleIds.has(role.id))
                    }
                  >
                    <span
                      className="mr-1 inline-block h-2 w-2 rounded-full"
                      style={{ backgroundColor: role.color }}
                    />
                    {role.name}
                  </ContextMenuCheckboxItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}

        {!isOwnUser && inSharedServer && can(Permission.MANAGE_USERS) && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => setModViewOpen(true, userId)}>
              Open in Mod View
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={handleKick}>
              Kick {user.name}
            </ContextMenuItem>
            <ContextMenuItem variant="destructive" onClick={handleBan}>
              Ban {user.name}
            </ContextMenuItem>
          </>
        )}

        {user.publicId && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={handleCopyUserId}>
              Copy User ID
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
});

UserContextMenu.displayName = 'UserContextMenu';

export { UserContextMenu };
