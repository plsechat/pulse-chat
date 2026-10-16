import { IncomingCallModal } from '@/components/dm-call/incoming-call-modal';
import { ForwardMessageDialog } from '@/components/forward-message-dialog';
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
import { UserControl } from '@/components/left-sidebar';
import { VoiceControl } from '@/components/left-sidebar/voice-control';
import { MobileBottomNav } from '@/components/mobile-bottom-nav';
import { ServerStrip } from '@/components/server-strip';
import { StreamPreviewPublisher } from '@/components/stream-preview-publisher';
import { useActiveView } from '@/features/app/hooks';
import { VoiceProvider } from '@/components/voice-provider';
import { PersistentAudioStreams } from '@/components/voice-provider/persistent-audio-streams';
import { useAutoAway } from '@/hooks/use-auto-away';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useTabNotifications } from '@/hooks/use-tab-notifications';
import { useVisualViewportHeight } from '@/hooks/use-visual-viewport';
import { LazyFallback } from '@/components/lazy-fallback';
import { lazy, memo, Suspense } from 'react';
import { HomeView } from '../home-view';
import { ServerView } from '../server-view';

// Discover is a destination the user navigates to, never the first
// screen, so its chunk waits until then.
const DiscoverView = lazy(() =>
  import('../discover-view').then((m) => ({ default: m.DiscoverView }))
);

const MainViewInner = memo(() => {
  const activeView = useActiveView();
  useTabNotifications();
  useAutoAway();
  // Keeps --vvh at the visible height so the shell shrinks for the soft
  // keyboard on browsers that only resize the visual viewport.
  useVisualViewportHeight();

  const { shortcutsDialogOpen, setShortcutsDialogOpen } = useKeyboardShortcuts();

  const renderView = () => {
    switch (activeView) {
      case 'home':
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
      <div className="flex h-(--vvh) bg-sidebar text-foreground pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        {/*
          Was `hidden md:flex` (≥ 768px), then `sm:flex` (≥ 640px) —
          but a fully collapsed desktop window goes below 640px and
          left users with no path to the server picker (MobileBottomNav
          isn't always obvious). At `min-[480px]` the strip stays
          visible across all realistic desktop widths and only hides
          on actual phones, where MobileBottomNav's Servers button
          is the documented entry point.
        */}
        <div className="hidden min-[480px]:flex">
          <ServerStrip />
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          {renderView()}
          <MobileBottomNav />
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
        {activeView !== 'discover' && (
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
