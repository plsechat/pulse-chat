import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import {
  fetchJoinedServers,
  leaveServer,
  setActiveView
} from '@/features/app/actions';
import { useActiveServerId } from '@/features/app/hooks';
import { openDialog, requestConfirmation } from '@/features/dialogs/actions';
import { openServerScreen } from '@/features/server-screens/actions';
import { disconnectFromServer } from '@/features/server/actions';
import { useIsOwnUserOwner, useServerName } from '@/features/server/hooks';
import { cn } from '@/lib/utils';
import { getTRPCClient } from '@/lib/trpc';
import { Permission } from '@pulse/shared';
import { ChevronDown } from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { Dialog } from '../dialogs/dialogs';
import { Protect } from '../protect';
import { ServerScreen } from '../server-screens/screens';
import { Categories } from './categories';
import { UserControl } from './user-control';
import { VoiceControl } from './voice-control';

type TLeftSidebarProps = {
  className?: string;
};

const LeftSidebar = memo(({ className }: TLeftSidebarProps) => {
  const serverName = useServerName();
  const isOwner = useIsOwnUserOwner();
  const activeServerId = useActiveServerId();

  const handleDeleteServer = useCallback(async () => {
    if (!activeServerId) return;

    const confirmed = await requestConfirmation({
      title: 'Delete Server',
      message:
        'Are you sure you want to delete this server? This action cannot be undone. All channels, messages, and data will be permanently deleted.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });

    if (!confirmed) return;

    try {
      const trpc = getTRPCClient();
      await trpc.servers.delete.mutate({ serverId: activeServerId });
      await fetchJoinedServers();
      toast.success('Server deleted');
      setActiveView('home');
    } catch (error) {
      console.error('Error deleting server:', error);
      toast.error('Failed to delete server');
    }
  }, [activeServerId]);

  const handleLeaveServer = useCallback(async () => {
    if (!activeServerId) return;

    const confirmed = await requestConfirmation({
      title: 'Leave Server',
      message: 'Are you sure you want to leave this server?',
      confirmLabel: 'Leave',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });

    if (!confirmed) return;

    await leaveServer(activeServerId);
    setActiveView('home');
  }, [activeServerId]);

  const serverSettingsPermissions = useMemo(
    () => [
      Permission.MANAGE_SETTINGS,
      Permission.MANAGE_ROLES,
      Permission.MANAGE_EMOJIS,
      Permission.MANAGE_STORAGE,
      Permission.MANAGE_USERS,
      Permission.MANAGE_INVITES,
      Permission.MANAGE_UPDATES
    ],
    []
  );

  return (
    <aside
      className={cn(
        'flex w-60 flex-col bg-card h-full overflow-hidden',
        className
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full justify-between h-12 items-center border-b border-border px-4 hover:bg-accent transition-colors cursor-pointer">
            <h2 className="text-[15px] font-semibold text-foreground tracking-tight truncate">{serverName}</h2>
            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Server</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <Protect permission={Permission.MANAGE_CATEGORIES}>
                <DropdownMenuItem
                  onClick={() => openDialog(Dialog.CREATE_CATEGORY)}
                >
                  Add Category
                </DropdownMenuItem>
              </Protect>
              <Protect permission={serverSettingsPermissions}>
                <DropdownMenuItem
                  onClick={() => openServerScreen(ServerScreen.SERVER_SETTINGS)}
                >
                  Server Settings
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </Protect>
              <Protect permission={Permission.MANAGE_INVITES}>
                <DropdownMenuItem
                  onClick={() => openDialog(Dialog.CREATE_INVITE)}
                >
                  Create Invite
                </DropdownMenuItem>
              </Protect>
              <DropdownMenuItem onClick={disconnectFromServer}>
                Disconnect
              </DropdownMenuItem>
              {!isOwner && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleLeaveServer}
                    className="text-destructive focus:text-destructive"
                  >
                    Leave Server
                  </DropdownMenuItem>
                </>
              )}
              {isOwner && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={handleDeleteServer}
                    className="text-destructive focus:text-destructive"
                  >
                    Delete Server
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
      </DropdownMenu>
      <div className="flex-1 overflow-y-auto">
        <Categories />
      </div>
      <VoiceControl />
      <UserControl />
    </aside>
  );
});

export { UserControl } from './user-control';
export { LeftSidebar };
