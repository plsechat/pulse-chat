import { CreateGroupDmDialog } from '@/components/dialogs/create-group-dm';
import { DmProfilePanel } from '@/components/dm-profile-panel';
import { UserControl } from '@/components/left-sidebar';
import { VoiceControl } from '@/components/left-sidebar/voice-control';
import { MobileHeader } from '@/components/mobile-header';
import { setSelectedDmChannelId } from '@/features/dms/actions';
import { useDmChannels } from '@/features/dms/hooks';
import {
  getLocalStorageItem,
  LocalStorageKey,
  removeLocalStorageItem,
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
  const savedTab = getSavedHomeTab();
  const savedDmId = getSavedDmChannelId();
  const [activeTab, setActiveTab] = useState<THomeTab>(savedTab);
  const [localSelectedDmChannelId, setLocalSelectedDmChannelId] = useState<
    number | undefined
  >(savedTab === 'dm' ? savedDmId : undefined);
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

  // Sync saved DM channel to Redux on mount so incoming messages
  // know the user is viewing this DM (prevents false unread badges)
  useEffect(() => {
    if (localSelectedDmChannelId) {
      setSelectedDmChannelId(localSelectedDmChannelId);
    }
    // Intentionally mount-only: sync initial saved state to Redux once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the active DM disappears from the channel list (self-delete,
  // peer delete pushed via DM_CHANNEL_DELETE, leave-group, or being
  // removed from a group), bounce back to Friends. Without this the
  // <DmConversation> would keep rendering against a non-existent channel
  // and trigger FORBIDDEN polls for the now-deleted channel.
  const dmChannels = useDmChannels();
  useEffect(() => {
    if (
      localSelectedDmChannelId !== undefined &&
      !dmChannels.some((c) => c.id === localSelectedDmChannelId)
    ) {
      setLocalSelectedDmChannelId(undefined);
      setSelectedDmChannelId(undefined);
      removeLocalStorageItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID);
      setActiveTab('friends');
      setLocalStorageItem(LocalStorageKey.HOME_TAB, 'friends');
    }
  }, [localSelectedDmChannelId, dmChannels]);

  const handleDmSelect = useCallback((dmChannelId: number) => {
    setLocalSelectedDmChannelId(dmChannelId);
    setSelectedDmChannelId(dmChannelId);
    setActiveTab('dm');
    setLocalStorageItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID, String(dmChannelId));
    setLocalStorageItem(LocalStorageKey.HOME_TAB, 'dm');
    if (isMobile) {
      setIsMobileMenuOpen(false);
    }
  }, [isMobile]);

  const handleFriendsClick = () => {
    setActiveTab('friends');
    setLocalSelectedDmChannelId(undefined);
    setSelectedDmChannelId(undefined);
    removeLocalStorageItem(LocalStorageKey.ACTIVE_DM_CHANNEL_ID);
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
            'flex w-60 flex-col border-r border-border bg-card h-full',
            'md:relative md:flex fixed inset-0 left-0 z-40 md:z-0 transition-transform duration-300 ease-in-out',
            isMobileMenuOpen
              ? 'translate-x-0'
              : '-translate-x-full md:translate-x-0'
          )}
        >
          <HomeSidebar
            activeTab={activeTab}
            selectedDmChannelId={localSelectedDmChannelId}
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

        <div className="flex flex-1 flex-col overflow-hidden">
          {activeTab === 'friends' ? (
            <FriendsPanel onDmSelect={handleDmSelect} />
          ) : localSelectedDmChannelId ? (
            <DmConversation
              dmChannelId={localSelectedDmChannelId}
              isProfilePanelOpen={isProfilePanelOpen && profilePanelAvailable}
              profilePanelAvailable={profilePanelAvailable}
              onToggleProfilePanel={handleToggleProfilePanel}
            />
          ) : (
            <FriendsPanel onDmSelect={handleDmSelect} />
          )}
        </div>

        {activeTab === 'dm' &&
          localSelectedDmChannelId !== undefined &&
          profilePanelAvailable && (
            <DmProfilePanel
              dmChannelId={localSelectedDmChannelId}
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
