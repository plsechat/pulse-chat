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
import { requestTextInput } from '@/features/dialogs/actions';
import { getOrCreateDmChannel, navigateToDm } from '@/features/dms/actions';
import { useCan, useUserRoles } from '@/features/server/hooks';
import { useRoles } from '@/features/server/roles/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { voiceMapSelector } from '@/features/server/voice/selectors';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { dispatchMentionUser } from '@/lib/events';
import { getTRPCClient } from '@/lib/trpc';
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
  const { getVolume, setVolume, toggleMute, getUserVolumeKey } =
    useVolumeControl();
  const isOwnUser = userId === ownUserId;

  const volumeKey = getUserVolumeKey(userId);
  const currentVolume = getVolume(volumeKey);
  const isMuted = currentVolume === 0;

  const isInVoice = useMemo(() => {
    for (const ch of Object.values(voiceMap)) {
      if (ch && ch.users[userId]) return true;
    }
    return false;
  }, [voiceMap, userId]);

  const userRoleIds = useMemo(
    () => new Set(userRoles.map((r) => r.id)),
    [userRoles]
  );

  const handleMention = useCallback(() => {
    if (user) {
      dispatchMentionUser(user.id, user.name);
    }
  }, [user]);

  const handleMessage = useCallback(async () => {
    const channel = await getOrCreateDmChannel(userId);
    if (channel) {
      // Land on the new DM, not just the home view in general.
      // navigateToDm bridges through HomeView's local state via the
      // dm-navigate CustomEvent — Redux alone doesn't re-render.
      await navigateToDm(channel.id);
    }
  }, [userId]);

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
          <ContextMenuItem onClick={handleMessage}>Message</ContextMenuItem>
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
          </>
        )}

        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleAddNote}>Add Note</ContextMenuItem>

        {!isOwnUser && can(Permission.MANAGE_USERS) && roles.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>Roles</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {roles.map((role) => (
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
      </ContextMenuContent>
    </ContextMenu>
  );
});

UserContextMenu.displayName = 'UserContextMenu';

export { UserContextMenu };
