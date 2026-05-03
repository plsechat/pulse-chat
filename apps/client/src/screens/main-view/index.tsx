import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
import { UserControl } from '@/components/left-sidebar';
import { VoiceControl } from '@/components/left-sidebar/voice-control';
import { MobileBottomNav } from '@/components/mobile-bottom-nav';
import { ServerStrip } from '@/components/server-strip';
import { useActiveView } from '@/features/app/hooks';
import { VoiceProvider } from '@/components/voice-provider';
import { PersistentAudioStreams } from '@/components/voice-provider/persistent-audio-streams';
import { useAutoAway } from '@/hooks/use-auto-away';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { useTabNotifications } from '@/hooks/use-tab-notifications';
import { memo } from 'react';
import { DiscoverView } from '../discover-view';
import { HomeView } from '../home-view';
import { ServerView } from '../server-view';

const MainViewInner = memo(() => {
  const activeView = useActiveView();
  useTabNotifications();
  useAutoAway();

  const { shortcutsDialogOpen, setShortcutsDialogOpen } = useKeyboardShortcuts();

  const renderView = () => {
    switch (activeView) {
      case 'home':
        return <HomeView />;
      case 'discover':
        return <DiscoverView />;
      case 'server':
        return <ServerView />;
    }
  };

  return (
    <>
      <PersistentAudioStreams />
      <div className="flex h-dvh bg-background text-foreground">
        {/*
          Was `hidden md:flex` (≥ 768px). At desktop widths between
          640–768px the strip vanished even though there's plenty of
          room for its 72px column — and MobileBottomNav was designed
          for true-mobile (< 640px) where the screen is genuinely too
          narrow for both the strip and the channel list. Lower the
          breakpoint to `sm:` so resizing a desktop window keeps the
          strip visible until you really cross into mobile territory.
        */}
        <div className="hidden sm:flex">
          <ServerStrip />
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          {renderView()}
          <MobileBottomNav />
        </div>
        {activeView !== 'discover' && (
          <div className="hidden md:block fixed bottom-6 left-2 z-20 w-[calc(72px+15rem-0.5rem)] rounded-xl bg-card border border-border overflow-hidden shadow-lg">
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
