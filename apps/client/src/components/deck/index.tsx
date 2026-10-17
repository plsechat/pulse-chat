import { Dialog } from '@/components/dialogs/dialogs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/user-avatar';
import { Tooltip } from '@/components/ui/tooltip';
import { activateTab } from '@/features/app/activate-tab';
import {
  canGoBack,
  canGoForward,
  closeTab,
  forgetTab,
  moveTab,
  nextActiveAfterClose,
  openTab,
  parseTabKey,
  recordVisit,
  stepHistory,
  tabKeyFor,
  togglePanel,
  useDeck,
  type TDeckPanel
} from '@/features/app/deck';
import {
  useActiveInstanceDomain,
  useActiveServerId,
  useActiveView,
  useFederatedMentionCounts,
  useFederatedServers,
  useFederatedUnreadCounts,
  useJoinedServers,
  useServerMentionCounts,
  useServerUnreadCounts,
  useTotalDmUnreadCount
} from '@/features/app/hooks';
import type { TFederatedServerEntry } from '@/features/app/slice';
import { openDialog } from '@/features/dialogs/actions';
import { useIncomingFriendRequestCount } from '@/features/friends/hooks';
import { communityTooltip } from '@/helpers/community-tooltip';
import { getFileUrl } from '@/helpers/get-file-url';
import { openServerScreen } from '@/features/server-screens/actions';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { ServerScreen } from '@/components/server-screens/screens';
import {
  closestCenter,
  DndContext,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core';
import {
  horizontalListSortingStrategy,
  SortableContext,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { TServerSummary } from '@pulse/server/types';
import {
  Bell,
  ChevronLeft,
  ChevronRight,
  Compass,
  Globe,
  House,
  MessageCircle,
  Plus,
  Users,
  X
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, type MouseEvent } from 'react';

/**
 * The deck: the top strip of the new layout. Open communities sit in it
 * as tabs (Home is always first), with back/forward over the tabs you
 * visited on the left and the user tray on the right. The active tab is
 * read from the app slice; this component only mirrors it into the tab
 * list and routes clicks back through the existing switch actions.
 */

/** A tab you can drag sideways to reorder; the keyboard reorders too. */
const SortableTab = memo(
  ({ id, children }: { id: string; children: React.ReactNode }) => {
    const {
      attributes,
      listeners,
      setNodeRef,
      transform,
      transition,
      isDragging
    } = useSortable({ id });
    return (
      <div
        ref={setNodeRef}
        style={{
          transform: CSS.Transform.toString(
            transform && { ...transform, y: 0, scaleX: 1, scaleY: 1 }
          ),
          transition,
          opacity: isDragging ? 0.6 : 1,
          zIndex: isDragging ? 1 : undefined
        }}
        className="shrink-0"
        {...attributes}
        {...listeners}
      >
        {children}
      </div>
    );
  }
);

const Badge = memo(({ count }: { count: number }) => {
  if (count <= 0) return null;
  return (
    <span
      aria-hidden
      className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground"
    >
      {count > 99 ? '99+' : count}
    </span>
  );
});

type TTabProps = {
  tabKey: string;
  label: string;
  /** Native tooltip: the full name (the label truncates) and, for a
   *  community, its description. */
  title?: string;
  icon?: TServerSummary['logo'];
  fallback: React.ReactNode;
  isActive: boolean;
  unread: boolean;
  mentions: number;
  closable: boolean;
  federated?: boolean;
  onActivate: (key: string) => void;
  onClose?: (key: string) => void;
};

const DeckTab = memo(
  ({
    tabKey,
    label,
    title,
    icon,
    fallback,
    isActive,
    unread,
    mentions,
    closable,
    federated,
    onActivate,
    onClose
  }: TTabProps) => {
    const name = `${label}${
      mentions > 0
        ? `, ${mentions} mention${mentions === 1 ? '' : 's'}`
        : unread
          ? ', unread'
          : ''
    }`;

    // Middle click closes, like a browser tab.
    const handleAuxClick = useCallback(
      (e: MouseEvent<HTMLDivElement>) => {
        if (e.button === 1 && closable && onClose) {
          e.preventDefault();
          onClose(tabKey);
        }
      },
      [closable, onClose, tabKey]
    );

    return (
      <div
        role="tab"
        aria-selected={isActive}
        aria-label={name}
        title={title}
        tabIndex={isActive ? 0 : -1}
        onClick={() => onActivate(tabKey)}
        onAuxClick={handleAuxClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onActivate(tabKey);
          }
        }}
        className={cn(
          'lift group/tab relative flex h-9 max-w-52 min-w-0 cursor-pointer select-none items-center gap-2 rounded-xl pl-1.5 pr-1.5 text-[13px]',
          isActive
            ? 'community-tab-active bg-background text-foreground'
            : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
          !isActive && unread && 'text-foreground'
        )}
      >
        <span className="squircle relative flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden bg-secondary text-[11px] font-semibold text-muted-foreground ring-1 ring-white/10">
          {icon ? (
            <img
              src={getFileUrl(icon)}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            fallback
          )}
          {federated && (
            <Globe
              aria-hidden
              className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-sidebar text-muted-foreground"
            />
          )}
        </span>
        <span className={cn('truncate', (isActive || unread) && 'font-medium')}>
          {label}
        </span>
        <Badge count={mentions} />
        {unread && mentions === 0 && (
          <span
            aria-hidden
            className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
          />
        )}
        {closable && onClose && (
          <button
            type="button"
            aria-label={`Close ${label}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tabKey);
            }}
            className={cn(
              'ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover/tab:opacity-100',
              isActive && 'opacity-100'
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    );
  }
);

type TTrayButtonProps = {
  label: string;
  panel: TDeckPanel;
  active: boolean;
  count?: number;
  children: React.ReactNode;
};

const TrayButton = memo(
  ({ label, panel, active, count = 0, children }: TTrayButtonProps) => (
    <Tooltip content={label} asChild>
      <button
        type="button"
        aria-label={count > 0 ? `${label}, ${count} new` : label}
        aria-pressed={active}
        onClick={() => togglePanel(panel)}
        className={cn(
          'relative flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
          active &&
            'bg-background text-foreground ring-1 ring-inset ring-border/60'
        )}
      >
        {children}
        {count > 0 && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground ring-2 ring-sidebar"
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
    </Tooltip>
  )
);

const Deck = memo(() => {
  const activeView = useActiveView();
  const activeServerId = useActiveServerId();
  const activeInstanceDomain = useActiveInstanceDomain();
  const activeKey = tabKeyFor(activeView, activeServerId, activeInstanceDomain);
  const ownUserId = useOwnUserId();

  const deck = useDeck();
  const joinedServers = useJoinedServers();
  const federatedServers = useFederatedServers();
  const unreadCounts = useServerUnreadCounts();
  const mentionCounts = useServerMentionCounts();
  const federatedUnread = useFederatedUnreadCounts();
  const federatedMentions = useFederatedMentionCounts();
  const dmUnread = useTotalDmUnreadCount();
  const pendingFriends = useIncomingFriendRequestCount();

  // Whatever is on screen is a tab, and a visit.
  useEffect(() => {
    openTab(activeKey);
    recordVisit(activeKey);
  }, [activeKey]);

  const serversById = useMemo(() => {
    const map = new Map<number, TServerSummary>();
    joinedServers.forEach((s) => map.set(s.id, s));
    return map;
  }, [joinedServers]);

  const federatedByKey = useMemo(() => {
    const map = new Map<string, TFederatedServerEntry>();
    federatedServers.forEach((e) =>
      map.set(`fed:${e.instanceDomain}:${e.server.id}`, e)
    );
    return map;
  }, [federatedServers]);

  // A tab whose community was left (or never loaded) disappears.
  useEffect(() => {
    if (joinedServers.length === 0 && federatedServers.length === 0) return;
    deck.tabs.forEach((key) => {
      const parsed = parseTabKey(key);
      const gone =
        (parsed.kind === 'server' && !serversById.has(parsed.serverId)) ||
        (parsed.kind === 'fed' && !federatedByKey.has(key));
      if (gone) {
        closeTab(key);
        forgetTab(key);
      }
    });
  }, [
    deck.tabs,
    serversById,
    federatedByKey,
    joinedServers.length,
    federatedServers.length
  ]);

  const handleClose = useCallback(
    (key: string) => {
      const next = nextActiveAfterClose(deck.tabs, key, activeKey);
      closeTab(key);
      if (next !== activeKey) activateTab(next);
    },
    [deck.tabs, activeKey]
  );

  const handleBack = useCallback(() => {
    const key = stepHistory(-1);
    if (key) activateTab(key);
  }, []);

  const handleForward = useCallback(() => {
    const key = stepHistory(1);
    if (key) activateTab(key);
  }, []);

  const closedServers = useMemo(
    () => joinedServers.filter((s) => !deck.tabs.includes(`server:${s.id}`)),
    [joinedServers, deck.tabs]
  );
  const closedFederated = useMemo(
    () =>
      federatedServers.filter(
        (e) => !deck.tabs.includes(`fed:${e.instanceDomain}:${e.server.id}`)
      ),
    [federatedServers, deck.tabs]
  );

  const back = canGoBack();
  const forward = canGoForward();

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 250, tolerance: 5 }
    })
  );
  const handleDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      if (!over || active.id === over.id) return;
      const from = deck.tabs.indexOf(String(active.id));
      const to = deck.tabs.indexOf(String(over.id));
      if (from !== -1 && to !== -1) moveTab(from, to);
    },
    [deck.tabs]
  );
  const inboxCount =
    Object.values(mentionCounts).reduce((a, b) => a + b, 0) +
    Object.values(federatedMentions).reduce((a, b) => a + b, 0);

  return (
    <div className="app-deck relative flex h-12 shrink-0 items-center gap-1 border-b border-sidebar-border bg-sidebar px-2">
      <div className="flex shrink-0 items-center">
        <button
          type="button"
          aria-label="Back"
          disabled={!back}
          onClick={handleBack}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-sidebar-accent enabled:hover:text-foreground disabled:opacity-30"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={!forward}
          onClick={handleForward}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors enabled:hover:bg-sidebar-accent enabled:hover:text-foreground disabled:opacity-30"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div
        role="tablist"
        aria-label="Open communities"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <DeckTab
          tabKey="home"
          label="Home"
          fallback={<House className="h-3.5 w-3.5" />}
          isActive={activeKey === 'home'}
          unread={false}
          mentions={0}
          closable={false}
          onActivate={activateTab}
        />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={deck.tabs}
            strategy={horizontalListSortingStrategy}
          >
            {deck.tabs.map((key) => {
              const parsed = parseTabKey(key);
              if (parsed.kind === 'discover') {
                return (
                  <SortableTab key={key} id={key}>
                    <DeckTab
                      key={key}
                      tabKey={key}
                      label="Discover"
                      fallback={<Compass className="h-3.5 w-3.5" />}
                      isActive={activeKey === key}
                      unread={false}
                      mentions={0}
                      closable
                      onActivate={activateTab}
                      onClose={handleClose}
                    />
                  </SortableTab>
                );
              }
              if (parsed.kind === 'server') {
                const server = serversById.get(parsed.serverId);
                if (!server) return null;
                return (
                  <SortableTab key={key} id={key}>
                    <DeckTab
                      key={key}
                      tabKey={key}
                      label={server.name}
                      title={communityTooltip(server.name, server.description)}
                      icon={server.logo}
                      fallback={server.name.charAt(0).toUpperCase()}
                      isActive={activeKey === key}
                      unread={(unreadCounts[server.id] ?? 0) > 0}
                      mentions={mentionCounts[server.id] ?? 0}
                      closable
                      onActivate={activateTab}
                      onClose={handleClose}
                    />
                  </SortableTab>
                );
              }
              if (parsed.kind === 'fed') {
                const entry = federatedByKey.get(key);
                if (!entry) return null;
                const countKey = `${entry.instanceDomain}:${entry.server.id}`;
                return (
                  <SortableTab key={key} id={key}>
                    <DeckTab
                      key={key}
                      tabKey={key}
                      label={entry.server.name}
                      title={communityTooltip(
                        `${entry.server.name} (${entry.instanceDomain})`,
                        entry.server.description
                      )}
                      icon={entry.server.logo}
                      fallback={entry.server.name.charAt(0).toUpperCase()}
                      isActive={activeKey === key}
                      unread={(federatedUnread[countKey] ?? 0) > 0}
                      mentions={federatedMentions[countKey] ?? 0}
                      closable
                      federated
                      onActivate={activateTab}
                      onClose={handleClose}
                    />
                  </SortableTab>
                );
              }
              return null;
            })}
          </SortableContext>
        </DndContext>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Open a community"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {closedServers.length + closedFederated.length > 0 && (
              <>
                <DropdownMenuLabel>Your communities</DropdownMenuLabel>
                {closedServers.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onSelect={() => activateTab(`server:${s.id}`)}
                  >
                    <span className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-md bg-secondary text-[11px] font-semibold">
                      {s.logo ? (
                        <img
                          src={getFileUrl(s.logo)}
                          alt=""
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        s.name.charAt(0).toUpperCase()
                      )}
                    </span>
                    <span className="truncate">{s.name}</span>
                    <Badge count={mentionCounts[s.id] ?? 0} />
                  </DropdownMenuItem>
                ))}
                {closedFederated.map((e) => (
                  <DropdownMenuItem
                    key={`${e.instanceDomain}:${e.server.id}`}
                    onSelect={() =>
                      activateTab(`fed:${e.instanceDomain}:${e.server.id}`)
                    }
                  >
                    <Globe className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{e.server.name}</span>
                    <span className="ml-auto truncate text-xs text-muted-foreground">
                      {e.instanceName}
                    </span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onSelect={() => activateTab('discover')}>
              <Compass className="h-4 w-4 text-muted-foreground" />
              Discover communities
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openDialog(Dialog.CREATE_SERVER)}>
              <Plus className="h-4 w-4 text-muted-foreground" />
              Create or join a community
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <TrayButton
          label="Friends"
          panel="friends"
          active={deck.panel === 'friends'}
          count={pendingFriends}
        >
          <Users className="h-4 w-4" />
        </TrayButton>
        <TrayButton
          label="Messages"
          panel="messages"
          active={deck.panel === 'messages'}
          count={dmUnread}
        >
          <MessageCircle className="h-4 w-4" />
        </TrayButton>
        <TrayButton
          label="Inbox"
          panel="inbox"
          active={deck.panel === 'inbox'}
          count={inboxCount}
        >
          <Bell className="h-4 w-4" />
        </TrayButton>
        {/* Your account from anywhere: the Home and Discover tabs have no
            channel pane, so the bottom-left user control is not on screen
            there. Voice and status controls stay on that card. */}
        <Tooltip content="User settings" asChild>
          <button
            type="button"
            aria-label="User settings"
            title="User settings"
            onClick={() => openServerScreen(ServerScreen.USER_SETTINGS)}
            className="ml-1 flex h-8 w-8 items-center justify-center rounded-full transition-shadow hover:ring-2 hover:ring-border"
          >
            {ownUserId !== undefined ? (
              <UserAvatar
                userId={ownUserId}
                className="h-7 w-7"
                homeScope
                showStatusBadge
                showUserPopover={false}
              />
            ) : (
              <span className="h-7 w-7 rounded-full bg-secondary" />
            )}
          </button>
        </Tooltip>
      </div>
    </div>
  );
});

export { Deck };
