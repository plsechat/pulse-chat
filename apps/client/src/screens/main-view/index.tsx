import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts-dialog';
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
        <div className="hidden md:flex">
          <ServerStrip />
        </div>
        <div className="flex flex-1 flex-col overflow-hidden">
          {renderView()}
          <MobileBottomNav />
        </div>
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
