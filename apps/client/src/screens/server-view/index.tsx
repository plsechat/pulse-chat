import { LeftSidebar } from '@/components/left-sidebar';
import { MobileHeader } from '@/components/mobile-header';
import { ModViewSheet } from '@/components/mod-view-sheet';
import { Protect } from '@/components/protect';
import { RightSidebar } from '@/components/right-sidebar';
import { TopBar } from '@/components/top-bar';
import { PinBanner } from '@/components/top-bar/pin-banner';
import { useSelectedChannelId } from '@/features/server/channels/hooks';
import { usePreviewMode } from '@/features/server/hooks';
import { getLocalStorageItem, LocalStorageKey } from '@/helpers/storage';
import { useHistoryOverlay } from '@/hooks/use-history-overlay';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useSwipeGestures } from '@/hooks/use-swipe-gestures';
import { useViewportAtLeast } from '@/hooks/use-viewport-breakpoint';
import { onAppEvent } from '@/lib/events';
import { syncPreference } from '@/lib/preferences-sync';
import { cn } from '@/lib/utils';
import { Permission } from '@pulse/shared';
import { memo, useCallback, useEffect, useState } from 'react';
import { ContentWrapper } from './content-wrapper';
import { PreventBrowser } from './prevent-browser';
import { PreviewBanner } from './preview-banner';

const ServerView = memo(() => {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isMobileUsersOpen, setIsMobileUsersOpen] = useState(false);
  const [isDesktopRightSidebarOpen, setIsDesktopRightSidebarOpen] = useState(
    getLocalStorageItem(LocalStorageKey.RIGHT_SIDEBAR_STATE) === 'true' || false
  );
  const selectedChannelId = useSelectedChannelId();
  // The channel drawer is an overlay below `md`; the members panel is
  // an overlay below `lg` (it docks into the layout only from 1024px).
  const isMobile = useIsMobile();
  const membersDocked = useViewportAtLeast(1024);
  const previewMode = usePreviewMode();

  const closeMenu = useCallback(() => setIsMobileMenuOpen(false), []);
  const closeUsers = useCallback(() => setIsMobileUsersOpen(false), []);

  // Auto-close both drawers when the channel changes. Not gated on a
  // breakpoint: the members overlay opened by a swipe at 768–1023px is
  // exactly the one that used to stay open.
  useEffect(() => {
    setIsMobileMenuOpen(false);
    setIsMobileUsersOpen(false);
  }, [selectedChannelId]);

  // Tapping the already-selected channel changes nothing in Redux, so
  // the effect above cannot see it — the row says so itself.
  useEffect(() => onAppEvent('channel-selected', closeMenu), [closeMenu]);

  // Growing past `lg` docks the members panel; an overlay flag left
  // true would otherwise force it open against the saved preference.
  useEffect(() => {
    if (membersDocked) setIsMobileUsersOpen(false);
  }, [membersDocked]);

  // The platform back gesture closes an open drawer instead of leaving.
  useHistoryOverlay(isMobileMenuOpen && isMobile, closeMenu);
  useHistoryOverlay(isMobileUsersOpen && !membersDocked, closeUsers);

  const handleDesktopRightSidebarToggle = useCallback(() => {
    const newState = !isDesktopRightSidebarOpen;
    setIsDesktopRightSidebarOpen(newState);
    localStorage.setItem(
      LocalStorageKey.RIGHT_SIDEBAR_STATE,
      newState ? 'true' : 'false'
    );
    syncPreference({ rightSidebarOpen: newState });
  }, [isDesktopRightSidebarOpen]);

  const handleMobileMembersToggle = useCallback(() => {
    if (previewMode) return;
    setIsMobileUsersOpen((prev) => !prev);
  }, [previewMode]);

  // One swipe moves one drawer: right closes the members drawer if it
  // is open, otherwise opens the channel drawer; left mirrors that.
  const handleSwipeRight = useCallback(() => {
    if (isMobileUsersOpen) {
      setIsMobileUsersOpen(false);
      return;
    }
    setIsMobileMenuOpen(true);
  }, [isMobileUsersOpen]);

  const handleSwipeLeft = useCallback(() => {
    if (isMobileMenuOpen) {
      setIsMobileMenuOpen(false);
      return;
    }
    // No member sidebar to reveal while previewing
    if (previewMode) return;
    setIsMobileUsersOpen(true);
  }, [isMobileMenuOpen, previewMode]);

  const swipeHandlers = useSwipeGestures({
    onSwipeRight: handleSwipeRight,
    onSwipeLeft: handleSwipeLeft
  });

  return (
    <div
      className="flex flex-1 min-h-0 flex-col"
      {...swipeHandlers}
    >
      {previewMode && <PreviewBanner />}
      <div className="flex flex-1 overflow-hidden relative">
        <PreventBrowser />

        {isMobileMenuOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-30"
            onClick={closeMenu}
          />
        )}

        {isMobileUsersOpen && (
          <div
            className="lg:hidden fixed inset-0 bg-black/50 z-30"
            onClick={closeUsers}
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

        {/* Floating content pane: chat + members share one rounded surface
            lifted off the canvas (desktop only; mobile stays full-bleed). */}
        <div className="flex flex-1 overflow-hidden bg-background md:mt-2 md:rounded-tl-2xl md:ring-1 md:ring-white/[0.045] md:ring-inset">
        <div className="flex flex-1 flex-col overflow-hidden">
          <MobileHeader
            onToggleLeftDrawer={() => setIsMobileMenuOpen((prev) => !prev)}
            onToggleRightDrawer={handleMobileMembersToggle}
          />
          <TopBar
            onToggleRightSidebar={handleDesktopRightSidebarToggle}
            onToggleMobileMembers={handleMobileMembersToggle}
            isOpen={isDesktopRightSidebarOpen}
          />
          <PinBanner />
          <ContentWrapper />
        </div>

        {/* Previews carry no member roster — drop the sidebar at the
            layout level rather than teaching it about preview state. */}
        {!previewMode && (
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
        )}
        </div>

        <Protect permission={Permission.MANAGE_USERS}>
          <ModViewSheet />
        </Protect>
      </div>
    </div>
  );
});

export { ServerView };
