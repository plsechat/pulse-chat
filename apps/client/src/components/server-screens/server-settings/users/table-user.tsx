import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/user-avatar';
import { setModViewOpen } from '@/features/app/actions';
import { useActiveServerId, useJoinedServers } from '@/features/app/hooks';
import {
  requestConfirmation,
  requestTextInput
} from '@/features/dialogs/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import { toast } from 'sonner';
import { useUserRoles } from '@/features/server/hooks';
import { useUserStatus } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { UserStatus, type TJoinedUser } from '@pulse/shared';
import { datePlusTime } from '@/helpers/time-format';
import { format, formatDistanceToNow } from 'date-fns';
import { Crown, MoreVertical, UserCog } from 'lucide-react';
import { memo, useCallback } from 'react';

type TTableUserProps = {
  user: TJoinedUser;
};

const TableUser = memo(({ user }: TTableUserProps) => {
  const ownUserId = useOwnUserId();
  const activeServerId = useActiveServerId();
  const joinedServers = useJoinedServers();
  // Ownership transfer is strictly the CURRENT owner's action — compare
  // the server's ownerId, not a role id (capability, not label).
  const isSelfOwner =
    joinedServers.find((srv) => srv.id === activeServerId)?.ownerId ===
    ownUserId;

  const onTransferOwnership = async () => {
    if (activeServerId === undefined) return;

    const confirmed = await requestConfirmation({
      title: 'Transfer Server Ownership',
      message: `You are about to make ${user.name} the owner of this server. You will permanently lose owner status, the Owner role, and the ability to reverse this — only ${user.name} could transfer it back.`,
      confirmLabel: 'Continue'
    });
    if (!confirmed) return;

    const typed = await requestTextInput({
      title: 'Confirm Transfer',
      message: `Type "${user.name}" to confirm handing over ownership.`,
      confirmLabel: 'Transfer Ownership'
    });
    if (typed === null || typed === undefined) return;
    if (typed.trim() !== user.name) {
      toast.error('Name did not match — ownership was not transferred');
      return;
    }

    try {
      const trpc = getTRPCClient();
      if (!trpc) return;
      await trpc.servers.transferOwner.mutate({
        serverId: activeServerId,
        newOwnerId: user.id
      });
      toast.success(`${user.name} is now the server owner`);
    } catch (err) {
      toast.error(getTrpcError(err, 'Failed to transfer ownership'));
    }
  };

  const roles = useUserRoles(user.id);
  const status = useUserStatus(user.id);

  const onModerateClick = useCallback(() => {
    setModViewOpen(true, user.id);
  }, [user.id]);

  return (
    <div
      key={user.id}
      className="grid grid-cols-[60px_1fr_120px_120px_120px_80px_50px] gap-4 px-4 py-3 text-sm hover:bg-muted/30 transition-colors"
    >
      <div className="flex items-center justify-center">
        <UserAvatar
          userId={user.id}
          className="h-8 w-8 flex-shrink-0"
          showUserPopover
        />
      </div>

      <div className="flex items-center min-w-0">
        <div className="min-w-0">
          <div className="font-medium text-foreground truncate">
            {user.name}
          </div>
          {user.bio && (
            <div className="text-xs text-muted-foreground truncate">
              {user.bio}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center min-w-0 gap-2">
        <span
          className="text-xs truncate text-muted-foreground"
          title={roles.map((role) => role.name).join(', ')}
        >
          {roles.map((role) => role.name).join(', ')}
        </span>
      </div>

      <div className="flex items-center text-muted-foreground">
        <span className="text-xs" title={format(user.createdAt, datePlusTime())}>
          {formatDistanceToNow(user.createdAt, { addSuffix: true })}
        </span>
      </div>

      <div className="flex items-center text-muted-foreground">
        <span className="text-xs">
          {formatDistanceToNow(user.lastLoginAt, { addSuffix: true })}
        </span>
      </div>

      <div className="flex items-center text-muted-foreground">
        <span
          className={cn('capitalize text-xs', {
            'text-green-500': status === UserStatus.ONLINE,
            'text-yellow-500': status === UserStatus.IDLE
          })}
        >
          {status}
        </span>
      </div>

      <div className="flex items-center justify-center">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
            >
              <MoreVertical className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onModerateClick}>
              <UserCog className="h-4 w-4" />
              Moderate User
            </DropdownMenuItem>
            {isSelfOwner && user.id !== ownUserId && !user.banned && (
              <DropdownMenuItem
                onClick={onTransferOwnership}
                className="text-destructive focus:text-destructive"
              >
                <Crown className="h-4 w-4" />
                Transfer Ownership
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
});

export { TableUser };
