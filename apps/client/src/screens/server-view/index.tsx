import { LeftSidebar } from '@/components/left-sidebar';
import { MobileHeader } from '@/components/mobile-header';
import { ModViewSheet } from '@/components/mod-view-sheet';
import { Protect } from '@/components/protect';
import { RightSidebar } from '@/components/right-sidebar';
import { TopBar } from '@/components/top-bar';
import { VoiceChatSidebar } from '@/components/voice-chat-sidebar';
import { useSelectedChannelId } from '@/features/server/channels/hooks';
import { getLocalStorageItem, LocalStorageKey } from '@/helpers/storage';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useSwipeGestures } from '@/hooks/use-swipe-gestures';
import { cn } from '@/lib/utils';
import { Permission } from '@pulse/shared';
import { memo, useCallback, useEffect, useState } from 'react';
import { ContentWrapper } from './content-wrapper';
import { PreventBrowser } from './prevent-browser';

const ServerView = memo(() => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileUsersOpen, setIsMobileUsersOpen] = useState(false);
  const [isDesktopRightSidebarOpen, setIsDesktopRightSidebarOpen] = useState(
    getLocalStorageItem(LocalStorageKey.RIGHT_SIDEBAR_STATE) === 'true' || false
  );
  const [isVoiceChatSidebarOpen, setIsVoiceChatSidebarOpen] = useState(
    getLocalStorageItem(LocalStorageKey.VOICE_CHAT_SIDEBAR_STATE) === 'true' ||
      false
  );
  const selectedChannelId = useSelectedChannelId();
  const isMobile = useIsMobile();

  // Auto-close mobile drawers when channel changes
  useEffect(() => {
    if (isMobile) {
      setIsMobileMenuOpen(false);
      setIsMobileUsersOpen(false);
    }
  }, [selectedChannelId, isMobile]);

  const handleDesktopRightSidebarToggle = useCallback(() => {
    setIsDesktopRightSidebarOpen((prev) => !prev);
    localStorage.setItem(
      LocalStorageKey.RIGHT_SIDEBAR_STATE,
      !isDesktopRightSidebarOpen ? 'true' : 'false'
    );
  }, [isDesktopRightSidebarOpen]);

  const handleVoiceChatSidebarToggle = useCallback(() => {
    setIsVoiceChatSidebarOpen((prev) => !prev);
    localStorage.setItem(
      LocalStorageKey.VOICE_CHAT_SIDEBAR_STATE,
      !isVoiceChatSidebarOpen ? 'true' : 'false'
    );
  }, [isVoiceChatSidebarOpen]);

  const handleSwipeRight = useCallback(() => {
    if (isMobileMenuOpen || isMobileUsersOpen) {
      setIsMobileMenuOpen(false);
      setIsMobileUsersOpen(false);
      return;
    }

    setIsMobileMenuOpen(true);
  }, [isMobileMenuOpen, isMobileUsersOpen]);

  const handleSwipeLeft = useCallback(() => {
    if (isMobileMenuOpen || isMobileUsersOpen) {
      setIsMobileMenuOpen(false);
      setIsMobileUsersOpen(false);

      return;
    }

    setIsMobileUsersOpen(true);
  }, [isMobileMenuOpen, isMobileUsersOpen]);

  const swipeHandlers = useSwipeGestures({
    onSwipeRight: handleSwipeRight,
    onSwipeLeft: handleSwipeLeft
  });

  return (
    <div
      className="flex flex-1 min-h-0 flex-col"
      {...swipeHandlers}
    >
      <div className="flex flex-1 overflow-hidden relative">
        <PreventBrowser />

        {isMobileMenuOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-30"
            onClick={() => setIsMobileMenuOpen(false)}
          />
        )}

        {isMobileUsersOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-black/50 z-30"
            onClick={() => setIsMobileUsersOpen(false)}
          />
        )}

        <LeftSidebar
          className={cn(
            'md:relative md:flex fixed inset-0 left-0 h-full z-40 md:z-0 transition-transform duration-300 ease-in-out',
            isMobileMenuOpen
              ? 'translate-x-0'
              : '-translate-x-full md:translate-x-0'
          )}
        />

        <div className="flex flex-1 flex-col overflow-hidden bg-background">
          <MobileHeader
            onToggleLeftDrawer={() => setIsMobileMenuOpen((prev) => !prev)}
            onToggleRightDrawer={() => setIsMobileUsersOpen((prev) => !prev)}
          />
          <TopBar
            onToggleRightSidebar={handleDesktopRightSidebarToggle}
            isOpen={isDesktopRightSidebarOpen}
            onToggleVoiceChat={handleVoiceChatSidebarToggle}
            isVoiceChatOpen={isVoiceChatSidebarOpen}
          />
          <ContentWrapper />
        </div>

        <VoiceChatSidebar isOpen={isVoiceChatSidebarOpen} />

        <RightSidebar
          className={cn(
            'fixed top-0 bottom-0 right-0 h-full z-40 transition-all duration-500 ease-in-out',
            'lg:relative lg:z-0',
            // Mobile behavior (< lg)
            isMobileUsersOpen
              ? 'translate-x-0 lg:translate-x-0'
              : 'translate-x-full lg:translate-x-0'
          )}
          isOpen={isDesktopRightSidebarOpen || isMobileUsersOpen}
        />

        <Protect permission={Permission.MANAGE_USERS}>
          <ModViewSheet />
        </Protect>
      </div>
    </div>
  );
});

export { ServerView };
