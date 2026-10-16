import { CreateGroupDmDialog } from '@/components/dialogs/create-group-dm';
import { DmProfilePanel } from '@/components/dm-profile-panel';
import { UserControl } from '@/components/left-sidebar';
import { VoiceControl } from '@/components/left-sidebar/voice-control';
import { MobileHeader } from '@/components/mobile-header';
import { setSelectedDmChannelId } from '@/features/dms/actions';
import { useDmChannels, useSelectedDmChannelId } from '@/features/dms/hooks';
import { useSelector } from 'react-redux';
import type { IRootState } from '@/features/store';
import {
  getLocalStorageItem,
  LocalStorageKey,
  setLocalStorageItem
} from '@/helpers/storage';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useSwipeGestures } from '@/hooks/use-swipe-gestures';
import { useViewportAtLeast } from '@/hooks/use-viewport-breakpoint';
import { cn } from '@/lib/utils';
import { memo, useCallback, useEffect, useState } from 'react';
import { DmConversation } from './dm-conversation';
import { HomeSidebar } from './home-sidebar';
import { FriendsPanel } from './friends-panel';
import { onAppEvent } from '@/lib/events';

export type THomeTab = 'friends' | 'dm';

function getSavedHomeTab(): THomeTab {
  const saved = getLocalStorageItem(LocalStorageKey.HOME_TAB);
  return saved === 'dm' ? 'dm' : 'friends';
}

function getSavedDmChannelId(): number | undefined {
  const saved = getLocalStorageItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID);
  return saved ? Number(saved) : undefined;
}

const HomeView = memo(() => {
  // Redux `dms.selectedChannelId` is the one source of truth for the open
  // DM (addDmMessages reads it to tell "on screen" from "unread"); the
  // slice seeds it from storage, and the setSelectedDmChannelId action
  // keeps the storage mirror current.
  const selectedDmChannelId = useSelectedDmChannelId();
  const dmChannelsLoaded = useSelector(
    (state: IRootState) => state.dms.channelsLoaded
  );
  const [activeTab, setActiveTab] = useState<THomeTab>(getSavedHomeTab);
  const [showCreateGroupDm, setShowCreateGroupDm] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  // Reuse the server view's RIGHT_SIDEBAR_STATE storage key so toggling
  // the panel in either screen reflects across both — one preference,
  // not two screen-specific ones.
  const [isProfilePanelOpen, setIsProfilePanelOpen] = useState(
    getLocalStorageItem(LocalStorageKey.RIGHT_SIDEBAR_STATE) === 'true' || false
  );
  // The DM profile panel needs the same room-to-breathe gate the
  // server members panel uses — below 1024px the canvas is too narrow
  // to fit it without crushing the message column.
  const profilePanelAvailable = useViewportAtLeast(1024);
  const isMobile = useIsMobile();

  const handleToggleProfilePanel = useCallback(() => {
    setIsProfilePanelOpen((prev) => {
      const next = !prev;
      setLocalStorageItem(
        LocalStorageKey.RIGHT_SIDEBAR_STATE,
        next ? 'true' : 'false'
      );
      return next;
    });
  }, []);

  // The slice seeds the selection on first load; after a sign-out reset
  // Redux is empty again while storage still names the DM, so re-seed
  // once on mount in that case.
  useEffect(() => {
    if (selectedDmChannelId !== undefined) return;
    if (getSavedHomeTab() !== 'dm') return;
    const saved = getSavedDmChannelId();
    if (saved !== undefined) setSelectedDmChannelId(saved);
    // Intentionally mount-only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // External "open this DM" requests (navigateToDm: popovers, context
  // menus, the incoming-call accept) select through Redux; this event
  // only flips the tab, which is view-local state.
  useEffect(() => {
    return onAppEvent('dm-navigate', () => {
      setActiveTab('dm');
    });
  }, []);

  // When the active DM disappears from the channel list (self-delete,
  // peer delete pushed via DM_CHANNEL_DELETE, leave-group, or being
  // removed from a group), bounce back to Friends. Without this the
  // <DmConversation> would keep rendering against a non-existent channel
  // and trigger FORBIDDEN polls for the now-deleted channel. Only once
  // the list has actually loaded — an in-flight fetch is not "missing".
  const dmChannels = useDmChannels();
  useEffect(() => {
    if (
      dmChannelsLoaded &&
      selectedDmChannelId !== undefined &&
      !dmChannels.some((c) => c.id === selectedDmChannelId)
    ) {
      setSelectedDmChannelId(undefined);
      setActiveTab('friends');
      setLocalStorageItem(LocalStorageKey.HOME_TAB, 'friends');
    }
  }, [dmChannelsLoaded, selectedDmChannelId, dmChannels]);

  const handleDmSelect = useCallback((dmChannelId: number) => {
    setSelectedDmChannelId(dmChannelId);
    setActiveTab('dm');
    setLocalStorageItem(LocalStorageKey.HOME_TAB, 'dm');
    if (isMobile) {
      setIsMobileMenuOpen(false);
    }
  }, [isMobile]);

  const handleFriendsClick = () => {
    setActiveTab('friends');
    setSelectedDmChannelId(undefined);
    setLocalStorageItem(LocalStorageKey.HOME_TAB, 'friends');
    if (isMobile) {
      setIsMobileMenuOpen(false);
    }
  };

  const handleGroupDmCreated = useCallback((dmChannelId: number) => {
    setShowCreateGroupDm(false);
    handleDmSelect(dmChannelId);
  }, [handleDmSelect]);

  const handleSwipeRight = useCallback(() => {
    if (!isMobileMenuOpen) {
      setIsMobileMenuOpen(true);
    }
  }, [isMobileMenuOpen]);

  const handleSwipeLeft = useCallback(() => {
    if (isMobileMenuOpen) {
      setIsMobileMenuOpen(false);
    }
  }, [isMobileMenuOpen]);

  const swipeHandlers = useSwipeGestures({
    onSwipeRight: handleSwipeRight,
    onSwipeLeft: handleSwipeLeft
  });

  return (
    <div className="flex flex-col flex-1 min-h-0" {...swipeHandlers}>
      <MobileHeader
        onToggleLeftDrawer={() => setIsMobileMenuOpen((prev) => !prev)}
        title="Home"
      />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Backdrop overlay for mobile drawer */}
        {isMobileMenuOpen && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-30"
            onClick={() => setIsMobileMenuOpen(false)}
          />
        )}

        <aside
          className={cn(
            'flex w-60 flex-col bg-transparent h-full',
            'md:relative md:flex fixed inset-0 left-0 z-40 md:z-0 transition-transform duration-300 ease-in-out',
            isMobileMenuOpen
              ? 'translate-x-0'
              : '-translate-x-full md:translate-x-0'
          )}
        >
          <HomeSidebar
            activeTab={activeTab}
            selectedDmChannelId={selectedDmChannelId}
            onDmSelect={handleDmSelect}
            onFriendsClick={handleFriendsClick}
            onCreateGroupDm={() => setShowCreateGroupDm(true)}
          />
          <div className="md:hidden">
            <VoiceControl />
            <UserControl />
          </div>
          <div className="hidden md:block h-[5.5rem] shrink-0" />
        </aside>

        <div className="flex flex-1 flex-col overflow-hidden bg-background md:mt-2 md:rounded-tl-2xl md:ring-1 md:ring-white/[0.045] md:ring-inset">
          {activeTab === 'friends' ? (
            <FriendsPanel onDmSelect={handleDmSelect} />
          ) : selectedDmChannelId ? (
            <DmConversation
              dmChannelId={selectedDmChannelId}
              isProfilePanelOpen={isProfilePanelOpen && profilePanelAvailable}
              profilePanelAvailable={profilePanelAvailable}
              onToggleProfilePanel={handleToggleProfilePanel}
            />
          ) : (
            <FriendsPanel onDmSelect={handleDmSelect} />
          )}
        </div>

        {activeTab === 'dm' &&
          selectedDmChannelId !== undefined &&
          profilePanelAvailable && (
            <DmProfilePanel
              dmChannelId={selectedDmChannelId}
              isOpen={isProfilePanelOpen}
            />
          )}

        {showCreateGroupDm && (
          <CreateGroupDmDialog
            onClose={() => setShowCreateGroupDm(false)}
            onCreated={handleGroupDmCreated}
          />
        )}
      </div>
    </div>
  );
});

export { HomeView };
