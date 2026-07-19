import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { UserAvatar } from '@/components/user-avatar';
import { ServerScreen } from '@/components/server-screens/screens';
import { setModViewOpen } from '@/features/app/actions';
import { getOrCreateDmChannel, navigateToDm } from '@/features/dms/actions';
import { openServerScreen } from '@/features/server-screens/actions';
import {
  openDialog,
  requestConfirmation,
  requestTextInput
} from '@/features/dialogs/actions';
import { useUserRoles } from '@/features/server/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getTrpcError } from '@/helpers/parse-trpc-errors';
import { getTRPCClient } from '@/lib/trpc';
import {
  Copy,
  Fingerprint,
  Gavel,
  MessageSquare,
  Plus,
  UserMinus
} from 'lucide-react';
import { memo, useCallback } from 'react';
import { toast } from 'sonner';
import { Dialog } from '../dialogs/dialogs';
import { RoleBadge } from '../role-badge';
import { useModViewContext } from './context';

const Header = memo(() => {
  const ownUserId = useOwnUserId();
  const { user, refetch } = useModViewContext();
  const userRoles = useUserRoles(user.id);

  const onRemoveRole = useCallback(
    async (roleId: number, roleName: string) => {
      const answer = await requestConfirmation({
        title: 'Remove Role',
        message: `Are you sure you want to remove the role "${roleName}" from this user?`,
        confirmLabel: 'Remove'
      });

      if (!answer) {
        return;
      }

      const trpc = getTRPCClient();
      if (!trpc) return;

      try {
        await trpc.users.removeRole.mutate({
          userId: user.id,
          roleId
        });
        toast.success('Role removed successfully');
      } catch (error) {
        toast.error(getTrpcError(error, 'Failed to remove role'));
      } finally {
        refetch();
      }
    },
    [user.id, refetch]
  );

  const onKick = useCallback(async () => {
    const reason = await requestTextInput({
      title: 'Kick User',
      message: 'Please provide a reason for kicking this user (optional).',
      confirmLabel: 'Kick',
      allowEmpty: true
    });

    if (reason === null) {
      return;
    }

    const trpc = getTRPCClient();
    if (!trpc) return;

    try {
      await trpc.users.kick.mutate({
        userId: user.id,
        reason
      });

      toast.success('User kicked successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to kick user'));
    } finally {
      refetch();
    }
  }, [user.id, refetch]);

  const onBan = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

    const reason = await requestTextInput({
      title: 'Ban User',
      message: 'Please provide a reason for banning this user (optional).',
      confirmLabel: 'Ban',
      allowEmpty: true
    });

    if (reason === null) {
      return;
    }

    try {
      await trpc.users.ban.mutate({
        userId: user.id,
        reason
      });
      toast.success('User banned successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to ban user'));
    } finally {
      refetch();
    }
  }, [user.id, refetch]);

  const onUnban = useCallback(async () => {
    const trpc = getTRPCClient();
    if (!trpc) return;

    const answer = await requestConfirmation({
      title: 'Unban User',
      message: 'Are you sure you want to unban this user?',
      confirmLabel: 'Unban'
    });

    if (!answer) {
      return;
    }

    try {
      await trpc.users.unban.mutate({
        userId: user.id
      });
      toast.success('User unbanned successfully');
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to unban user'));
    } finally {
      refetch();
    }
  }, [user.id, refetch]);

  const onMessage = useCallback(async () => {
    try {
      const channel = await getOrCreateDmChannel(user.id);
      if (channel) {
        setModViewOpen(false);
        await navigateToDm(channel.id);
      }
    } catch (error) {
      toast.error(getTrpcError(error, 'Failed to open DM'));
    }
  }, [user.id]);

  const onVerify = useCallback(() => {
    setModViewOpen(false);
    openServerScreen(ServerScreen.USER_SETTINGS, {
      initialSection: 'verify-identity',
      initialVerifyPeerId: user.id
    });
  }, [user.id]);

  const onCopyId = useCallback(() => {
    navigator.clipboard.writeText(user.publicId ?? String(user.id));
    toast.success('User ID copied');
  }, [user.publicId, user.id]);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <UserAvatar userId={user.id} className="h-12 w-12" />
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold text-foreground">
            {user.name}
          </h2>
        </div>
      </div>

      {/* Quick actions — segmented icon strip. Kick works on offline
          members too (membership removal is not presence-dependent). */}
      <div className="flex overflow-hidden rounded-lg border border-border/60 divide-x divide-border/60">
        <Tooltip content="Message">
          <button
            type="button"
            onClick={onMessage}
            disabled={user.id === ownUserId}
            className="flex h-10 flex-1 items-center justify-center text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content="Verify Identity">
          <button
            type="button"
            onClick={onVerify}
            disabled={user.id === ownUserId}
            className="flex h-10 flex-1 items-center justify-center text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
          >
            <Fingerprint className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content="Kick">
          <button
            type="button"
            onClick={onKick}
            disabled={user.id === ownUserId}
            className="flex h-10 flex-1 items-center justify-center text-muted-foreground transition-colors duration-100 hover:bg-destructive/15 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
          >
            <UserMinus className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content={user.banned ? 'Unban' : 'Ban'}>
          <button
            type="button"
            onClick={() => (user.banned ? onUnban() : onBan())}
            disabled={user.id === ownUserId}
            className="flex h-10 flex-1 items-center justify-center text-muted-foreground transition-colors duration-100 hover:bg-destructive/15 hover:text-destructive disabled:pointer-events-none disabled:opacity-40"
          >
            <Gavel className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip content="Copy User ID">
          <button
            type="button"
            onClick={onCopyId}
            className="flex h-10 flex-1 items-center justify-center text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground"
          >
            <Copy className="h-4 w-4" />
          </button>
        </Tooltip>
      </div>

      <div className="flex flex-wrap gap-1.5 items-center">
        {userRoles.map((role) => (
          <RoleBadge key={role.id} role={role} onRemoveRole={onRemoveRole} />
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={() => openDialog(Dialog.ASSIGN_ROLE, { user, refetch })}
        >
          <Plus className="h-3 w-3" />
          Assign Role
        </Button>
      </div>
    </div>
  );
});

export { Header };
