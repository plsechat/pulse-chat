import { LazyFallback } from '@/components/lazy-fallback';
import { UserControl } from '@/components/left-sidebar';
import { VoiceControl } from '@/components/left-sidebar/voice-control';
import { UserAvatar } from '@/components/user-avatar';
import {
  openConversationPanel,
  PANEL_EXPANDED,
  PANEL_MAX,
  PANEL_MIN,
  setMessagesView,
  setPanel,
  setPanelWidth,
  togglePanelExpanded,
  useDeck
} from '@/features/app/deck';
import { setSelectedDmChannelId } from '@/features/dms/actions';
import { useDmChannels, useSelectedDmChannelId } from '@/features/dms/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import type { IRootState } from '@/features/store';
import { onAppEvent } from '@/lib/events';
import { cn } from '@/lib/utils';
import { ArrowLeft, Maximize2, Minimize2, X } from 'lucide-react';
import { lazy, memo, Suspense, useCallback, useEffect, useRef } from 'react';
import { useSelector } from 'react-redux';
import { InboxPanel } from './inbox-panel';

// The home-view surfaces are big; they load the first time a panel opens.
const FriendsPanel = lazy(() =>
  import('@/screens/home-view/friends-panel').then((m) => ({
    default: m.FriendsPanel
  }))
);
const HomeSidebar = lazy(() =>
  import('@/screens/home-view/home-sidebar').then((m) => ({
    default: m.HomeSidebar
  }))
);
const DmConversation = lazy(() =>
  import('@/screens/home-view/dm-conversation').then((m) => ({
    default: m.DmConversation
  }))
);

const PANEL_TITLES = {
  friends: 'Friends',
  messages: 'Messages',
  inbox: 'Inbox',
  profile: 'Profile'
} as const;

/** Drag the panel's left edge to resize it; width is persisted. */
const ResizeHandle = memo(() => {
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const aside = e.currentTarget.parentElement;
    if (!aside) return;
    start.current = {
      x: e.clientX,
      width: aside.getBoundingClientRect().width
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    setPanelWidth(start.current.width + (start.current.x - e.clientX));
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    start.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none hover:bg-primary/30 active:bg-primary/40"
    />
  );
});

const ProfilePanel = memo(() => {
  const ownUserId = useOwnUserId();
  const user = useUserById(ownUserId ?? -1);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col items-center gap-3 px-6 pb-6 pt-8">
        {ownUserId !== undefined && (
          <UserAvatar
            userId={ownUserId}
            className="h-20 w-20"
            homeScope
            showStatusBadge
            showUserPopover={false}
          />
        )}
        <div className="text-center">
          <div className="text-base font-semibold text-foreground">
            {user?.name ?? ''}
          </div>
          {user?.customStatus && (
            <div className="mt-0.5 text-sm text-muted-foreground">
              {user.customStatus}
            </div>
          )}
        </div>
      </div>
      <div className="mx-3 rounded-xl border border-border bg-card">
        <VoiceControl />
        <UserControl />
      </div>
    </div>
  );
});

const MessagesPanel = memo(() => {
  const { messagesView } = useDeck();
  const selectedDmChannelId = useSelectedDmChannelId();
  const dmChannels = useDmChannels();
  const channelsLoaded = useSelector(
    (state: IRootState) => state.dms.channelsLoaded
  );

  // The conversation view needs a conversation that still exists.
  const conversationOpen =
    messagesView === 'conversation' &&
    selectedDmChannelId !== undefined &&
    (!channelsLoaded || dmChannels.some((c) => c.id === selectedDmChannelId));

  useEffect(() => {
    if (
      messagesView === 'conversation' &&
      !conversationOpen &&
      channelsLoaded
    ) {
      setMessagesView('list');
    }
  }, [messagesView, conversationOpen, channelsLoaded]);

  const handleDmSelect = useCallback((dmChannelId: number) => {
    setSelectedDmChannelId(dmChannelId);
    setMessagesView('conversation');
  }, []);

  if (conversationOpen) {
    return (
      <DmConversation
        dmChannelId={selectedDmChannelId}
        profilePanelAvailable={false}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <HomeSidebar
        activeTab="dm"
        selectedDmChannelId={selectedDmChannelId}
        onDmSelect={handleDmSelect}
        onFriendsClick={() => setPanel('friends')}
        hideHeader
      />
    </div>
  );
});

const DeckSidePanel = memo(() => {
  const { panel, panelWidth, panelExpanded, messagesView } = useDeck();

  // "Open this DM" from anywhere (popovers, menus, accepting a call)
  // lands in the Messages panel.
  useEffect(
    () =>
      onAppEvent('dm-navigate', () => {
        openConversationPanel();
      }),
    []
  );

  const handleFriendsDmSelect = useCallback((dmChannelId: number) => {
    setSelectedDmChannelId(dmChannelId);
    openConversationPanel();
  }, []);

  if (!panel) return null;

  const width = panelExpanded
    ? Math.max(panelWidth, PANEL_EXPANDED)
    : panelWidth;
  const showBack = panel === 'messages' && messagesView === 'conversation';

  return (
    <aside
      aria-label={PANEL_TITLES[panel]}
      style={{
        width,
        minWidth: PANEL_MIN,
        maxWidth: Math.max(PANEL_MAX, width)
      }}
      className="panel-enter surface relative my-2 mr-2 flex shrink-0 flex-col overflow-hidden rounded-2xl bg-background"
    >
      <ResizeHandle />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 pl-3 pr-2">
        {showBack && (
          <button
            type="button"
            aria-label="Back to conversations"
            onClick={() => setMessagesView('list')}
            className="-ml-1 flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
          {PANEL_TITLES[panel]}
        </span>
        {panel === 'messages' && (
          <button
            type="button"
            aria-label={panelExpanded ? 'Shrink panel' : 'Expand panel'}
            onClick={togglePanelExpanded}
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {panelExpanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
        )}
        <button
          type="button"
          aria-label="Close panel"
          onClick={() => setPanel(null)}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          panel === 'inbox' && 'overflow-y-auto'
        )}
      >
        <Suspense fallback={<LazyFallback />}>
          {panel === 'friends' && (
            <FriendsPanel onDmSelect={handleFriendsDmSelect} />
          )}
          {panel === 'messages' && <MessagesPanel />}
          {panel === 'inbox' && <InboxPanel />}
          {panel === 'profile' && <ProfilePanel />}
        </Suspense>
      </div>
    </aside>
  );
});

export { DeckSidePanel };
