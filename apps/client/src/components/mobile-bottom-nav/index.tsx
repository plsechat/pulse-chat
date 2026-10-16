import {
  leaveServerContext,
  setActiveView,
  switchServer,
  switchToFederatedServer
} from '@/features/app/actions';
import {
  useActiveInstanceDomain,
  useActiveServerId,
  useActiveView,
  useFederatedMentionCounts,
  useFederatedServers,
  useFederatedUnreadCounts,
  useJoinedServers,
  useServerMentionCounts,
  useServerUnreadCounts
} from '@/features/app/hooks';
import { openDialog } from '@/features/dialogs/actions';
import { useIncomingFriendRequestCount } from '@/features/friends/hooks';
import { getHandshakeHash } from '@/features/server/actions';
import { openServerScreen } from '@/features/server-screens/actions';
import { getFileUrl } from '@/helpers/get-file-url';
import { useHistoryOverlay } from '@/hooks/use-history-overlay';
import { cn } from '@/lib/utils';
import type { TServerSummary } from '@pulse/server/types';
import { Compass, Globe, Home, Plus, Server, User } from 'lucide-react';
import { useKeyboardVisible } from '@/hooks/use-keyboard-visible';
import { memo, useCallback, useState } from 'react';
import { Dialog } from '../dialogs/dialogs';
import { ServerScreen } from '../server-screens/screens';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '../ui/sheet';

type TServerTileProps = {
  server: TServerSummary;
  isActive: boolean;
  unreadCount: number;
  mentionCount: number;
  /** Instance domain for a federated server; undefined for home. */
  instanceDomain?: string;
  onClick: () => void;
};

/**
 * One server in the sheet grid: logo or initial, the same unread dot /
 * mention pill the rail shows, and the instance name for a federated
 * one. The badge is aria-hidden; the counts are folded into the name.
 */
const ServerTile = memo(
  ({
    server,
    isActive,
    unreadCount,
    mentionCount,
    instanceDomain,
    onClick
  }: TServerTileProps) => {
    const firstLetter = server.name.charAt(0).toUpperCase();
    const badge =
      mentionCount > 0
        ? `, ${mentionCount} mention${mentionCount === 1 ? '' : 's'}`
        : unreadCount > 0
          ? ', unread'
          : '';

    return (
      <button
        type="button"
        onClick={onClick}
        className="flex flex-col items-center gap-1.5"
        aria-label={`${server.name}${instanceDomain ? ` on ${instanceDomain}` : ''}${badge}`}
        aria-current={isActive ? 'page' : undefined}
      >
        <div className="relative">
          <div
            className={cn(
              'flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 overflow-hidden',
              isActive
                ? 'bg-primary text-primary-foreground rounded-xl ring-2 ring-primary ring-offset-2 ring-offset-background'
                : 'bg-secondary text-muted-foreground'
            )}
          >
            {server.logo ? (
              <img
                src={getFileUrl(server.logo, instanceDomain)}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="text-lg font-semibold">{firstLetter}</span>
            )}
          </div>
          {mentionCount > 0 ? (
            <span
              aria-hidden
              className="absolute -top-1 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[9px] font-bold text-destructive-foreground ring-2 ring-background"
            >
              {mentionCount > 99 ? '99+' : mentionCount}
            </span>
          ) : unreadCount > 0 ? (
            <span
              aria-hidden
              className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-foreground ring-2 ring-background"
            />
          ) : null}
          {instanceDomain && (
            <span
              aria-hidden
              className="absolute -bottom-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full bg-background text-blue-500"
            >
              <Globe className="h-3 w-3" />
            </span>
          )}
        </div>
        <span className="text-[11px] text-foreground truncate max-w-[64px] text-center">
          {server.name}
        </span>
      </button>
    );
  }
);

const MobileBottomNav = memo(() => {
  const activeView = useActiveView();
  const pendingCount = useIncomingFriendRequestCount();
  const joinedServers = useJoinedServers();
  const federatedServers = useFederatedServers();
  const activeServerId = useActiveServerId();
  const activeInstanceDomain = useActiveInstanceDomain();
  const serverUnreadCounts = useServerUnreadCounts();
  const serverMentionCounts = useServerMentionCounts();
  const federatedUnreadCounts = useFederatedUnreadCounts();
  const federatedMentionCounts = useFederatedMentionCounts();
  const [showServerSheet, setShowServerSheet] = useState(false);
  const isKeyboardVisible = useKeyboardVisible();

  const closeServerSheet = useCallback(() => setShowServerSheet(false), []);
  useHistoryOverlay(showServerSheet, closeServerSheet);

  const handleHomeClick = useCallback(() => {
    leaveServerContext();
  }, []);

  const handleDiscoverClick = useCallback(() => {
    setActiveView('discover');
  }, []);

  const handleServersClick = useCallback(() => {
    setShowServerSheet(true);
  }, []);

  const handleServerSelect = useCallback((serverId: number) => {
    const hash = getHandshakeHash();
    if (hash) {
      switchServer(serverId, hash);
    }
    setShowServerSheet(false);
  }, []);

  const handleFederatedSelect = useCallback(
    (instanceDomain: string, serverId: number) => {
      switchToFederatedServer(instanceDomain, serverId);
      setShowServerSheet(false);
    },
    []
  );

  const handleAddServer = useCallback(() => {
    setShowServerSheet(false);
    openDialog(Dialog.CREATE_SERVER);
  }, []);

  const handleUserClick = useCallback(() => {
    openServerScreen(ServerScreen.USER_SETTINGS);
  }, []);

  return (
    <>
      {/* The safe-area inset is ADDED to the height (border-box would
          otherwise eat it from the 3.5rem and leave ~22px of content). */}
      <nav className={cn(
        'flex min-[480px]:hidden h-[calc(3.5rem+env(safe-area-inset-bottom))] w-full border-t border-border bg-sidebar items-center justify-around px-2 pb-[env(safe-area-inset-bottom)] transition-all duration-200',
        isKeyboardVisible && 'h-0 overflow-hidden border-t-0 opacity-0 pointer-events-none'
      )}>
        <button
          onClick={handleHomeClick}
          className={cn(
            'flex flex-col items-center justify-center gap-0.5 flex-1 py-1 transition-colors relative',
            activeView === 'home'
              ? 'text-foreground'
              : 'text-muted-foreground'
          )}
          // The badge count below is aria-hidden so the name stays
          // "Home, …" instead of "Home 3 Home" (mirrors the server rail).
          aria-label={`Home${
            pendingCount > 0
              ? `, ${pendingCount} pending friend request${pendingCount === 1 ? '' : 's'}`
              : ''
          }`}
          aria-current={activeView === 'home' ? 'page' : undefined}
        >
          <div className="relative">
            <Home className="h-5 w-5" />
            {pendingCount > 0 && (
              <span
                aria-hidden
                title={`${pendingCount} pending friend request${pendingCount === 1 ? '' : 's'}`}
                className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[9px] font-bold text-destructive-foreground"
              >
                {pendingCount}
              </span>
            )}
          </div>
          <span className="text-[10px]">Home</span>
          {activeView === 'home' && (
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-primary" />
          )}
        </button>

        <button
          onClick={handleDiscoverClick}
          className={cn(
            'flex flex-col items-center justify-center gap-0.5 flex-1 py-1 transition-colors relative',
            activeView === 'discover'
              ? 'text-foreground'
              : 'text-muted-foreground'
          )}
          aria-current={activeView === 'discover' ? 'page' : undefined}
        >
          <Compass className="h-5 w-5" />
          <span className="text-[10px]">Discover</span>
          {activeView === 'discover' && (
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-primary" />
          )}
        </button>

        <button
          onClick={handleServersClick}
          className={cn(
            'flex flex-col items-center justify-center gap-0.5 flex-1 py-1 transition-colors relative',
            activeView === 'server'
              ? 'text-foreground'
              : 'text-muted-foreground'
          )}
          aria-current={activeView === 'server' ? 'page' : undefined}
        >
          <Server className="h-5 w-5" />
          <span className="text-[10px]">Servers</span>
          {activeView === 'server' && (
            <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-0.5 w-6 rounded-full bg-primary" />
          )}
        </button>

        <button
          onClick={handleUserClick}
          className="flex flex-col items-center justify-center gap-0.5 flex-1 py-1 transition-colors text-muted-foreground"
        >
          <User className="h-5 w-5" />
          <span className="text-[10px]">You</span>
        </button>
      </nav>

      <Sheet
        open={showServerSheet}
        onOpenChange={setShowServerSheet}
      >
        <SheetContent
          side="bottom"
          close={closeServerSheet}
          className="max-h-[70dvh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader>
            <SheetTitle>Servers</SheetTitle>
            <SheetDescription className="sr-only">
              Your servers, federated servers, and adding a new one
            </SheetDescription>
          </SheetHeader>
          <div className="overflow-y-auto px-4 pb-4">
            <div className="grid grid-cols-4 gap-3">
              {joinedServers.map((server) => (
                <ServerTile
                  key={server.id}
                  server={server}
                  isActive={
                    activeView === 'server' &&
                    activeServerId === server.id &&
                    !activeInstanceDomain
                  }
                  unreadCount={serverUnreadCounts[server.id] ?? 0}
                  mentionCount={serverMentionCounts[server.id] ?? 0}
                  onClick={() => handleServerSelect(server.id)}
                />
              ))}
              {federatedServers.map((entry) => {
                const key = `${entry.instanceDomain}:${entry.server.id}`;
                return (
                  <ServerTile
                    key={key}
                    server={entry.server}
                    instanceDomain={entry.instanceDomain}
                    isActive={
                      activeView === 'server' &&
                      activeServerId === entry.server.id &&
                      activeInstanceDomain === entry.instanceDomain
                    }
                    unreadCount={federatedUnreadCounts[key] ?? 0}
                    mentionCount={federatedMentionCounts[key] ?? 0}
                    onClick={() =>
                      handleFederatedSelect(entry.instanceDomain, entry.server.id)
                    }
                  />
                );
              })}
              <button
                type="button"
                onClick={handleAddServer}
                className="flex flex-col items-center gap-1.5"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-dashed border-border text-muted-foreground">
                  <Plus className="h-5 w-5" />
                </div>
                <span className="text-[11px] text-muted-foreground truncate max-w-[64px] text-center">
                  Add server
                </span>
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
});

export { MobileBottomNav };
