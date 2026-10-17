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
import {
  useActiveInstanceDomain,
  useActiveServerId
} from '@/features/app/hooks';
import { openDialog, requestConfirmation } from '@/features/dialogs/actions';
import { openServerScreen } from '@/features/server-screens/actions';
import { disconnectFromServer } from '@/features/server/actions';
import {
  useCan,
  useIsInstanceOwner,
  useIsOwnUserOwner,
  usePreviewMode,
  useServerName
} from '@/features/server/hooks';
import { usersSelector } from '@/features/server/users/selectors';
import type { IRootState } from '@/features/store';
import { getFileUrl } from '@/helpers/get-file-url';
import { useLayoutMode } from '@/hooks/use-appearance-settings';
import { getTRPCClient } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { Permission, UserStatus } from '@pulse/shared';
import { ChevronDown, LogOut } from 'lucide-react';
import { memo, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { toast } from 'sonner';
import { Dialog } from '../dialogs/dialogs';
import { Protect } from '../protect';
import { ServerScreen } from '../server-screens/screens';
import { canOpenServerSettings } from '../server-screens/server-settings/permissions';
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
  const previewMode = usePreviewMode();
  const deck = useLayoutMode() === 'deck';
  const users = useSelector(usersSelector);
  const memberCount = users.length;
  const onlineCount = users.filter(
    (u) => u.status && u.status !== UserStatus.OFFLINE
  ).length;
  const serverLogo = useSelector(
    (state: IRootState) => state.server.info?.logo ?? null
  );

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
      if (!trpc) return;
      await trpc.servers.delete.mutate({ serverId: activeServerId });
      await fetchJoinedServers();
      toast.success('Server deleted');
      setActiveView('home');
    } catch (error) {
      console.error('Error deleting server:', error);
      toast.error('Failed to delete server');
    }
  }, [activeServerId]);

  const handleLogOut = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: 'Log Out',
      message:
        'Are you sure you want to log out? Your end-to-end encryption keys will be cleared from this device. Make sure you have a backup of your keys before proceeding.',
      confirmLabel: 'Log Out',
      cancelLabel: 'Cancel',
      variant: 'danger'
    });

    if (!confirmed) return;

    disconnectFromServer();
  }, []);

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

  // One gate for the menu entry and the screen: every permission that
  // unlocks a section, plus the instance owner (who always has the
  // Instance group on the home instance, whatever their server roles).
  const can = useCan();
  const isInstanceOwner = useIsInstanceOwner();
  const activeInstanceDomain = useActiveInstanceDomain();
  const showServerSettings = canOpenServerSettings(
    can,
    isInstanceOwner,
    activeInstanceDomain
  );

  return (
    <aside
      className={cn(
        // Transparent on the desktop canvas; opaque as the mobile drawer,
        // or the chat shows through it over the 50% backdrop.
        'flex w-60 flex-col bg-sidebar shadow-xl h-full overflow-hidden',
        deck
          ? 'md:surface-soft md:my-2 md:ml-2 md:h-auto md:rounded-2xl md:bg-channels md:shadow-none'
          : 'md:bg-transparent md:shadow-none',
        className
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="community-header flex w-full h-16 items-center gap-3 px-3 hover:brightness-110 transition-[filter] cursor-pointer">
            <span className="squircle flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden bg-background/60 text-sm font-bold text-foreground ring-1 ring-white/10">
              {serverLogo ? (
                <img
                  src={getFileUrl(serverLogo)}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                (serverName ?? '?').charAt(0).toUpperCase()
              )}
            </span>
            <span className="min-w-0 flex-1 text-left">
              <h2 className="text-[15px] font-semibold text-foreground tracking-tight truncate leading-5">
                {serverName}
              </h2>
              <span className="block text-[11px] text-muted-foreground truncate tabular-nums">
                {onlineCount > 0 && (
                  <>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 align-middle mr-1" />
                    {onlineCount} online ·{' '}
                  </>
                )}
                {memberCount} member{memberCount === 1 ? '' : 's'}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Server
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <Protect permission={Permission.MANAGE_CATEGORIES}>
            <DropdownMenuItem
              onClick={() => openDialog(Dialog.CREATE_CATEGORY)}
            >
              Add Category
            </DropdownMenuItem>
          </Protect>
          {showServerSettings && (
            <>
              <DropdownMenuItem
                onClick={() => openServerScreen(ServerScreen.SERVER_SETTINGS)}
              >
                Server Settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <Protect permission={Permission.MANAGE_INVITES}>
            <DropdownMenuItem onClick={() => openDialog(Dialog.CREATE_INVITE)}>
              Create Invite
            </DropdownMenuItem>
          </Protect>
          <DropdownMenuItem onClick={handleLogOut}>
            <LogOut className="h-4 w-4 mr-2" />
            Log Out
          </DropdownMenuItem>
          {/* Previewers aren't members — nothing to leave */}
          {!isOwner && !previewMode && (
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
      {/*
        `pt-2` here matches the visual gap between the bottom of the
        channel list and the floating user-control bar (which sits over
        the 5.5rem spacer below). Without it, the server-name border
        sat directly against the first category header — visibly tighter
        than the bottom — and the sidebar looked top-heavy. The mobile
        branch doesn't get a floating bar, so it doesn't need symmetry.
      */}
      <div className="flex-1 overflow-y-auto md:pt-2">
        <Categories />
      </div>
      {/* The deck layout has no rail, so the voice and user controls sit
          at the foot of the channel list instead of floating over it. */}
      <div
        className={cn(
          deck
            ? 'surface-soft mx-2 mb-2 rounded-xl bg-card overflow-hidden ring-1 ring-white/[0.05]'
            : 'md:hidden'
        )}
      >
        <VoiceControl />
        <UserControl stacked={deck} />
      </div>
      {!deck && <div className="hidden md:block h-[5.5rem] shrink-0" />}
    </aside>
  );
});

export { UserControl } from './user-control';
export { LeftSidebar };
