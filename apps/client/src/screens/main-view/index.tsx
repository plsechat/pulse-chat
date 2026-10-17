import { Deck } from '@/components/deck';
import { DeckSidePanel } from '@/components/deck/side-panel';
import { IncomingCallModal } from '@/components/dm-call/incoming-call-modal';
import { ForwardMessageDialog } from '@/components/forward-message-dialog';
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
import { LazyFallback } from '@/components/lazy-fallback';
import { UserControl } from '@/components/left-sidebar';
import { VoiceControl } from '@/components/left-sidebar/voice-control';
import { MobileBottomNav } from '@/components/mobile-bottom-nav';
import { ServerStrip } from '@/components/server-strip';
import { StreamPreviewPublisher } from '@/components/stream-preview-publisher';
import { UserAvatar } from '@/components/user-avatar';
import { VoiceProvider } from '@/components/voice-provider';
import { PersistentAudioStreams } from '@/components/voice-provider/persistent-audio-streams';
import { openConversationPanel } from '@/features/app/deck';
import {
  useActiveInstanceDomain,
  useActiveServerId,
  useActiveView
} from '@/features/app/hooks';
import { setSelectedDmChannelId } from '@/features/dms/actions';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { useLayoutMode } from '@/hooks/use-appearance-settings';
import { useAutoAway } from '@/hooks/use-auto-away';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useTabNotifications } from '@/hooks/use-tab-notifications';
import { useViewportAtLeast } from '@/hooks/use-viewport-breakpoint';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport';
import { cn } from '@/lib/utils';
import { lazy, memo, Suspense } from 'react';
import { HomeView } from '../home-view';
import { ServerView } from '../server-view';

// Discover is a destination the user navigates to, never the first
// screen, so its chunk waits until then.
const DiscoverView = lazy(() =>
  import('../discover-view').then((m) => ({ default: m.DiscoverView }))
);
// Home in the deck layout is the Friends surface; conversations live in
// the Messages panel, so the home screen's own sidebar is not mounted.
const FriendsPanel = lazy(() =>
  import('../home-view/friends-panel').then((m) => ({
    default: m.FriendsPanel
  }))
);

/** The first line of the Home tab: who you are and who is around. */
const HomeGreeting = memo(() => {
  const ownUserId = useOwnUserId();
  const user = useUserById(ownUserId ?? -1);
  const hour = new Date().getHours();
  const greeting =
    hour < 5
      ? 'Late night'
      : hour < 12
        ? 'Good morning'
        : hour < 18
          ? 'Good afternoon'
          : 'Good evening';
  if (!user) return null;
  return (
    <div className="community-header flex items-center gap-3 px-5 py-4">
      <UserAvatar
        userId={user.id}
        className="squircle h-11 w-11"
        homeScope
        showStatusBadge
        showUserPopover={false}
      />
      <div className="min-w-0">
        <div className="truncate text-base font-semibold text-foreground">
          {greeting}, {user.name}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {user.customStatus || 'Your friends and conversations live here.'}
        </div>
      </div>
    </div>
  );
});

const MainViewInner = memo(() => {
  const activeView = useActiveView();
  useTabNotifications();
  useAutoAway();
  // Keeps --vvh at the visible height so the shell shrinks for the soft
  // keyboard on browsers that only resize the visual viewport.
  useVisualViewportHeight();

  const { shortcutsDialogOpen, setShortcutsDialogOpen } =
    useKeyboardShortcuts();

  // The deck layout is a desktop shell: phones keep the drawer shell
  // whatever the preference says.
  const layout = useLayoutMode();
  const wide = useViewportAtLeast(768);
  const deck = layout === 'deck' && wide;

  // The community in focus tints the shell (deck glow, channel header,
  // active channel). Home and Discover fall back to the brand hue.
  const activeServerId = useActiveServerId();
  const activeInstanceDomain = useActiveInstanceDomain();
  const renderView = () => {
    switch (activeView) {
      case 'home':
        if (deck) {
          return (
            <div className="surface flex flex-1 flex-col overflow-hidden bg-background md:my-2 md:ml-2 md:rounded-2xl">
              <HomeGreeting />
              <Suspense fallback={<LazyFallback />}>
                <FriendsPanel
                  onDmSelect={(dmChannelId) => {
                    setSelectedDmChannelId(dmChannelId);
                    openConversationPanel();
                  }}
                />
              </Suspense>
            </div>
          );
        }
        return <HomeView />;
      case 'discover':
        return (
          <Suspense fallback={<LazyFallback />}>
            <DiscoverView />
          </Suspense>
        );
      case 'server':
        return <ServerView />;
    }
  };

  return (
    <>
      <PersistentAudioStreams />
      <StreamPreviewPublisher />
      <IncomingCallModal />
      <ForwardMessageDialog />
      {/* h-(--vvh): the visual-viewport height (index.css / use-visual-
          viewport), 100dvh where nothing shrinks it. The side insets
          keep the shell off a phone's rounded corners and notch in
          landscape (viewport-fit=cover, index.html). */}
      <div
        className={cn(
          'flex h-(--vvh) bg-sidebar text-foreground pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
          deck && 'flex-col'
        )}
      >
        {deck && <Deck />}
        <div className={cn('flex min-h-0 flex-1', !deck && 'contents')}>
          {/*
          Was `hidden md:flex` (≥ 768px), then `sm:flex` (≥ 640px) —
          but a fully collapsed desktop window goes below 640px and
          left users with no path to the server picker (MobileBottomNav
          isn't always obvious). At `min-[480px]` the strip stays
          visible across all realistic desktop widths and only hides
          on actual phones, where MobileBottomNav's Servers button
          is the documented entry point.
        */}
          {/* The deck's tab strip already lists every open community with
              Home, Discover and "Create or join" on it; the rail beside the
              channel list would show the same servers a second time. */}
          {!deck && (
            <div className="hidden min-[480px]:flex">
              <ServerStrip />
            </div>
          )}
          <div
            key={
              deck
                ? `${activeView}:${activeServerId ?? ''}:${activeInstanceDomain ?? ''}`
                : 'classic'
            }
            className={cn(
              'flex flex-1 flex-col overflow-hidden',
              deck && 'view-enter'
            )}
          >
            {renderView()}
            <MobileBottomNav />
          </div>
          {deck && <DeckSidePanel />}
        </div>
        {/*
          Width math on the floating user-control box below: server
          strip 72px + LeftSidebar 15rem (240px) - 1.5rem (24px) =
          288px. With `left-2` (8px), the box's right edge sits at
          x=296. The visible message-input left edge is at x=328
          (sidebar ends at x=312, input has 16px left padding). That
          puts the 32px gap perfectly centered around x=312 — the
          channel-list right edge. Earlier `-0.5rem` stretched the
          box to x=312 directly, leaving the gap entirely on the
          right of the sidebar line; the user flagged the asymmetry.
        */}
        {/* In the deck layout the box only belongs under a channel list
            (Home has none, the Profile panel carries the same controls),
            and there is no rail to the left of it. */}
        {activeView !== 'discover' && !deck && (
          <div className="hidden md:block fixed bottom-6 left-2 z-20 w-[calc(72px+15rem-1.5rem)] rounded-xl bg-card border border-border overflow-hidden shadow-lg">
            <VoiceControl />
            <UserControl />
          </div>
        )}
      </div>
      <KeyboardShortcutsDialog
        open={shortcutsDialogOpen}
        onOpenChange={setShortcutsDialogOpen}
      />
    </>
  );
});

const MainView = memo(() => {
  return (
    <VoiceProvider>
      <MainViewInner />
    </VoiceProvider>
  );
});

export { MainView };
