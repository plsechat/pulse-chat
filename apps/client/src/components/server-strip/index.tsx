import {
  deleteServer,
  leaveFederatedServer,
  leaveServer,
  setActiveView,
  switchServer,
  switchToFederatedServer
} from '@/features/app/actions';
import {
  useActiveInstanceDomain,
  useActiveServerId,
  useActiveView,
  useFederatedConnectionStatuses,
  useFederatedServers,
  useJoinedServers,
  useServerMentionCounts,
  useServerUnreadCounts,
  useTotalDmUnreadCount
} from '@/features/app/hooks';
import type { TFederatedServerEntry } from '@/features/app/slice';
import { appSliceActions } from '@/features/app/slice';
import { getHandshakeHash } from '@/features/server/actions';
import { useFriendRequests } from '@/features/friends/hooks';
import { useOwnUserId } from '@/features/server/users/hooks';
import { openDialog } from '@/features/dialogs/actions';
import { Dialog } from '@/components/dialogs/dialogs';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog';
import { useCurrentVoiceServerId } from '@/features/server/channels/hooks';
import { useHasAnyVoiceUsers } from '@/features/server/hooks';
import { cn } from '@/lib/utils';
import { getHomeTRPCClient, getTRPCClient } from '@/lib/trpc';
import { getFileUrl } from '@/helpers/get-file-url';
import { store } from '@/features/store';
import { serverSliceActions } from '@/features/server/slice';
import { dmsSliceActions } from '@/features/dms/slice';
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Compass, Home, Plus, Volume2 } from 'lucide-react';
import { memo, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { TServerSummary } from '@pulse/shared';

const ServerIcon = memo(
  ({
    server,
    isActive,
    hasUnread,
    hasMentions,
    hasVoiceActivity,
    onClick
  }: {
    server: TServerSummary;
    isActive: boolean;
    hasUnread: boolean;
    hasMentions: boolean;
    hasVoiceActivity: boolean;
    onClick: () => void;
  }) => {
    const firstLetter = server.name.charAt(0).toUpperCase();

    return (
      <div className="relative flex w-full items-center justify-center group">
        <div className={cn(
          'absolute -left-0.5 w-1.5 rounded-full bg-foreground transition-all duration-200',
          isActive ? 'h-10' : hasUnread ? 'h-2' : 'h-0 group-hover:h-5'
        )} />
        <button
          onClick={onClick}
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 overflow-hidden',
            isActive
              ? 'bg-primary text-primary-foreground rounded-xl'
              : 'bg-secondary text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:rounded-xl'
          )}
          title={server.name}
        >
          {server.logo ? (
            <img
              src={getFileUrl(server.logo)}
              alt={server.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-lg font-semibold">{firstLetter}</span>
          )}
        </button>
        {hasMentions && !hasVoiceActivity && (
          <div className="absolute -bottom-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive border-2 border-sidebar px-1 text-[10px] font-bold text-destructive-foreground" />
        )}
        {hasVoiceActivity && (
          <div className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-green-600 border-2 border-sidebar">
            <Volume2 className="h-3 w-3 text-white" />
          </div>
        )}
      </div>
    );
  }
);

const FederatedServerIcon = memo(
  ({
    entry,
    isActive,
    connectionStatus,
    onClick
  }: {
    entry: TFederatedServerEntry;
    isActive: boolean;
    connectionStatus?: 'connecting' | 'connected' | 'disconnected';
    onClick: () => void;
  }) => {
    const firstLetter = entry.server.name.charAt(0).toUpperCase();
    const instanceInitial = entry.instanceDomain.charAt(0).toUpperCase();
    const isOffline = connectionStatus === 'disconnected';
    const isReconnecting = connectionStatus === 'connecting';

    const statusSuffix = isOffline
      ? ' - Disconnected'
      : isReconnecting
        ? ' - Reconnecting...'
        : '';

    return (
      <div className="relative flex w-full items-center justify-center group">
        <div
          className={cn(
            'absolute -left-0.5 w-1.5 rounded-full bg-foreground transition-all duration-200',
            isActive ? 'h-10' : 'h-0 group-hover:h-5'
          )}
        />
        <button
          onClick={onClick}
          className={cn(
            'relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200 overflow-hidden',
            isActive
              ? 'bg-primary text-primary-foreground rounded-xl'
              : 'bg-secondary text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:rounded-xl',
            isOffline && 'opacity-50'
          )}
          title={`${entry.server.name} (${entry.instanceDomain})${statusSuffix}`}
        >
          {entry.server.logo ? (
            <img
              src={getFileUrl(entry.server.logo, entry.instanceDomain)}
              alt={entry.server.name}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-lg font-semibold">{firstLetter}</span>
          )}
        </button>
        {/* Federation badge — color indicates connection status */}
        <div
          className={cn(
            'absolute -bottom-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full border border-sidebar text-[8px] font-bold text-white pointer-events-none',
            isOffline
              ? 'bg-destructive'
              : isReconnecting
                ? 'bg-yellow-600'
                : 'bg-blue-600'
          )}
        >
          {instanceInitial}
        </div>
      </div>
    );
  }
);

const SortableServerItem = memo(
  ({ children, serverId }: { children: React.ReactNode; serverId: number }) => {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging
    } = useSortable({ id: serverId });

    return (
      <div
        ref={setNodeRef}
        className="w-full"
        style={{
          transform: CSS.Transform.toString(
            transform && { ...transform, x: 0 }
          ),
          transition,
          opacity: isDragging ? 0.5 : 1
        }}
        {...attributes}
        {...listeners}
      >
        {children}
      </div>
    );
  }
);

const ServerStrip = memo(() => {
  const activeView = useActiveView();
  const friendRequests = useFriendRequests();
  const ownUserId = useOwnUserId();
  const pendingCount = friendRequests.filter(
    (r) => r.receiverId === ownUserId
  ).length;
  const joinedServers = useJoinedServers();
  const activeServerId = useActiveServerId();
  const serverUnreadCounts = useServerUnreadCounts();
  const serverMentionCounts = useServerMentionCounts();
  const totalDmUnreadCount = useTotalDmUnreadCount();
  const hasAnyVoiceUsers = useHasAnyVoiceUsers();
  const currentVoiceServerId = useCurrentVoiceServerId();
  const federatedServers = useFederatedServers();
  const activeInstanceDomain = useActiveInstanceDomain();
  const federatedConnectionStatuses = useFederatedConnectionStatuses();

  const serverIds = useMemo(
    () => joinedServers.map((s) => s.id),
    [joinedServers]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8
      }
    })
  );

  const [deleteTarget, setDeleteTarget] = useState<TServerSummary | null>(null);
  const [serverMuted, setServerMuted] = useState(false);
  const [serverNotifLevel, setServerNotifLevel] = useState('default');

  const handleHomeClick = useCallback(() => {
    setActiveView('home');
  }, []);

  const handleDiscoverClick = useCallback(() => {
    setActiveView('discover');
  }, []);

  const handleServerClick = useCallback(
    (serverId: number) => {
      const hash = getHandshakeHash();
      if (hash) {
        switchServer(serverId, hash);
      }
    },
    []
  );

  const handleFederatedServerClick = useCallback(
    (entry: TFederatedServerEntry) => {
      switchToFederatedServer(entry.instanceDomain, entry.server.id);
    },
    []
  );

  const handleLeaveFederatedServer = useCallback(
    (instanceDomain: string, serverId: number) => {
      leaveFederatedServer(instanceDomain, serverId);
    },
    []
  );

  const handleCreateServer = useCallback(() => {
    openDialog(Dialog.CREATE_SERVER);
  }, []);

  const handleLeaveServer = useCallback(
    (serverId: number) => {
      leaveServer(serverId);
    },
    []
  );

  const handleConfirmDelete = useCallback(() => {
    if (deleteTarget) {
      deleteServer(deleteTarget.id);
      setDeleteTarget(null);
    }
  }, [deleteTarget]);

  const handleMarkAsRead = useCallback(
    async (serverId: number) => {
      try {
        const trpc = getTRPCClient();
        await trpc.notifications.markServerAsRead.mutate({ serverId });
        // Optimistically reset server-level unread and mention counts
        store.dispatch(
          appSliceActions.setServerUnreadCount({ serverId, count: 0, mentionCount: 0 })
        );
        // Also clear active server's channel read states if applicable
        const state = store.getState();
        if (state.app.activeServerId === serverId) {
          for (const channelId of Object.keys(state.server.readStatesMap)) {
            store.dispatch(
              serverSliceActions.setChannelReadState({
                channelId: Number(channelId),
                count: 0
              })
            );
          }
        }
        toast.success('Marked as read');
      } catch {
        toast.error('Failed to mark as read');
      }
    },
    []
  );

  const handleMarkAllDmsAsRead = useCallback(async () => {
    try {
      store.dispatch(dmsSliceActions.clearAllUnread());
      const trpc = getHomeTRPCClient();
      await trpc.dms.markAllAsRead.mutate();
      toast.success('Marked as read');
    } catch {
      toast.error('Failed to mark as read');
    }
  }, []);

  const handleToggleMute = useCallback(
    async (serverId: number, muted: boolean) => {
      try {
        const trpc = getTRPCClient();
        await trpc.notifications.setServerMute.mutate({ serverId, muted });
        setServerMuted(muted);
      } catch {
        toast.error('Failed to update mute setting');
      }
    },
    []
  );

  const handleSetNotificationLevel = useCallback(
    async (serverId: number, level: string) => {
      try {
        const trpc = getTRPCClient();
        await trpc.notifications.setServerNotificationLevel.mutate({
          serverId,
          level: level as 'all' | 'mentions' | 'nothing' | 'default'
        });
        setServerNotifLevel(level);
      } catch {
        toast.error('Failed to update notification setting');
      }
    },
    []
  );

  const handleContextMenuOpen = useCallback(
    async (open: boolean, serverId: number) => {
      if (open) {
        try {
          const trpc = getTRPCClient();
          const settings = await trpc.notifications.getServerSettings.query({
            serverId
          });
          setServerMuted(settings.muted);
          setServerNotifLevel(settings.notificationLevel);
        } catch {
          // Silently fail — use defaults
        }
      }
    },
    []
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;

      if (!over || active.id === over.id) {
        return;
      }

      const oldIndex = serverIds.indexOf(active.id as number);
      const newIndex = serverIds.indexOf(over.id as number);

      if (oldIndex === -1 || newIndex === -1) {
        return;
      }

      const reorderedIds = [...serverIds];
      const [movedId] = reorderedIds.splice(oldIndex, 1);
      reorderedIds.splice(newIndex, 0, movedId!);

      store.dispatch(appSliceActions.reorderJoinedServers(reorderedIds));

      try {
        const trpc = getTRPCClient();
        await trpc.servers.reorder.mutate({ serverIds: reorderedIds });
      } catch {
        toast.error('Failed to reorder servers');
      }
    },
    [serverIds]
  );

  return (
    <div className="flex w-[72px] flex-col items-center gap-2 bg-sidebar py-3">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="relative flex w-full items-center justify-center group">
            <div className={cn(
              'absolute -left-0.5 w-1.5 rounded-full bg-foreground transition-all duration-200',
              activeView === 'home' ? 'h-10' : 'h-0 group-hover:h-5'
            )} />
            <button
              onClick={handleHomeClick}
              className={cn(
                'relative flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200',
                activeView === 'home'
                  ? 'bg-primary text-primary-foreground rounded-xl'
                  : 'bg-secondary text-muted-foreground hover:bg-primary hover:text-primary-foreground hover:rounded-xl'
              )}
              title="Home"
            >
              <Home className="h-6 w-6" />
              {(pendingCount > 0 || totalDmUnreadCount > 0) && (
                <span className="absolute -bottom-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                  {pendingCount + totalDmUnreadCount > 99 ? '99+' : pendingCount + totalDmUnreadCount}
                </span>
              )}
            </button>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {totalDmUnreadCount > 0 && (
            <ContextMenuItem onClick={handleMarkAllDmsAsRead}>
              Mark as Read
            </ContextMenuItem>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <div className="mx-2 h-0.5 w-8 bg-border" />

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={serverIds}
          strategy={verticalListSortingStrategy}
        >
          {joinedServers.map((server) => {
            const isOwner = ownUserId != null && server.ownerId === ownUserId;

            return (
              <SortableServerItem key={server.id} serverId={server.id}>
                <ContextMenu
                  onOpenChange={(open) =>
                    handleContextMenuOpen(open, server.id)
                  }
                >
                  <ContextMenuTrigger asChild>
                    <div className="w-full">
                      <ServerIcon
                        server={server}
                        isActive={
                          activeView === 'server' &&
                          activeServerId === server.id &&
                          !activeInstanceDomain
                        }
                        hasUnread={
                          (serverUnreadCounts[server.id] ?? 0) > 0
                        }
                        hasMentions={
                          (serverMentionCounts[server.id] ?? 0) > 0
                        }
                        hasVoiceActivity={
                          server.id === currentVoiceServerId ||
                          (activeServerId === server.id &&
                            !activeInstanceDomain &&
                            hasAnyVoiceUsers)
                        }
                        onClick={() => handleServerClick(server.id)}
                      />
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    {(serverUnreadCounts[server.id] ?? 0) > 0 && (
                      <ContextMenuItem
                        onClick={() => handleMarkAsRead(server.id)}
                      >
                        Mark as Read
                      </ContextMenuItem>
                    )}
                    <ContextMenuCheckboxItem
                      checked={serverMuted}
                      onCheckedChange={(checked) =>
                        handleToggleMute(server.id, !!checked)
                      }
                    >
                      Mute Server
                    </ContextMenuCheckboxItem>
                    <ContextMenuSub>
                      <ContextMenuSubTrigger>
                        Notifications
                      </ContextMenuSubTrigger>
                      <ContextMenuSubContent>
                        <ContextMenuRadioGroup
                          value={serverNotifLevel}
                          onValueChange={(value) =>
                            handleSetNotificationLevel(server.id, value)
                          }
                        >
                          <ContextMenuRadioItem value="all">
                            All Messages
                          </ContextMenuRadioItem>
                          <ContextMenuRadioItem value="mentions">
                            Only @Mentions
                          </ContextMenuRadioItem>
                          <ContextMenuRadioItem value="nothing">
                            Nothing
                          </ContextMenuRadioItem>
                          <ContextMenuRadioItem value="default">
                            Default
                          </ContextMenuRadioItem>
                        </ContextMenuRadioGroup>
                      </ContextMenuSubContent>
                    </ContextMenuSub>
                    <ContextMenuSeparator />
                    {isOwner ? (
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => setDeleteTarget(server)}
                      >
                        Delete Server
                      </ContextMenuItem>
                    ) : (
                      <ContextMenuItem
                        variant="destructive"
                        onClick={() => handleLeaveServer(server.id)}
                      >
                        Leave Server
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              </SortableServerItem>
            );
          })}
        </SortableContext>
      </DndContext>

      {federatedServers.length > 0 && (
        <>
          <div className="mx-2 h-0.5 w-8 bg-border" />
          {federatedServers.map((entry) => (
            <ContextMenu key={`${entry.instanceDomain}:${entry.server.id}`}>
              <ContextMenuTrigger asChild>
                <div className="w-full">
                  <FederatedServerIcon
                    entry={entry}
                    isActive={
                      activeView === 'server' &&
                      activeServerId === entry.server.id &&
                      activeInstanceDomain === entry.instanceDomain
                    }
                    connectionStatus={
                      federatedConnectionStatuses[entry.instanceDomain]
                    }
                    onClick={() => handleFederatedServerClick(entry)}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  variant="destructive"
                  onClick={() =>
                    handleLeaveFederatedServer(
                      entry.instanceDomain,
                      entry.server.id
                    )
                  }
                >
                  Leave Federated Server
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </>
      )}

      <button
        onClick={handleCreateServer}
        className="flex h-12 w-12 items-center justify-center rounded-2xl bg-secondary text-green-500 transition-all duration-200 hover:bg-green-600 hover:text-white hover:rounded-xl"
        title="Create Server"
      >
        <Plus className="h-6 w-6" />
      </button>

      <div className="relative flex w-full items-center justify-center group">
        <div className={cn(
          'absolute -left-0.5 w-1.5 rounded-full bg-foreground transition-all duration-200',
          activeView === 'discover' ? 'h-10' : 'h-0 group-hover:h-5'
        )} />
        <button
          onClick={handleDiscoverClick}
          className={cn(
            'flex h-12 w-12 items-center justify-center rounded-2xl transition-all duration-200',
            activeView === 'discover'
              ? 'bg-green-600 text-white rounded-xl'
              : 'bg-secondary text-green-500 hover:bg-green-600 hover:text-white hover:rounded-xl'
          )}
          title="Discover Servers"
        >
          <Compass className="h-6 w-6" />
        </button>
      </div>

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Server</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{' '}
              <strong>{deleteTarget?.name}</strong>? This action cannot be
              undone. All channels, messages, and data will be permanently
              removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleConfirmDelete}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});

export { ServerStrip };
