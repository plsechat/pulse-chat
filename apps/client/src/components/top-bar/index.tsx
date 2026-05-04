import { Button } from '@/components/ui/button';
import {
  useCurrentVoiceChannelId,
  useIsCurrentVoiceChannelSelected,
  useSelectedChannel
} from '@/features/server/channels/hooks';
import { useDismissOnOutsideClick } from '@/hooks/use-dismiss-on-outside-click';
import { useViewportAtLeast } from '@/hooks/use-viewport-breakpoint';
import { cn } from '@/lib/utils';
import { Hash, LayoutList, List, Lock, MessageSquare, PanelRight, PanelRightClose, Pin, Search, Volume2 } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { SearchPopover } from '../search/search-popover';
import { Tooltip } from '../ui/tooltip';
import { NotificationDropdown } from './notification-dropdown';
import { PinnedMessagesPanel } from './pinned-messages-panel';
import { ThreadListPopover } from './thread-list-popover';
import { VolumeController } from './volume-controller';

type TTopBarProps = {
  onToggleRightSidebar: () => void;
  isOpen: boolean;
  onToggleVoiceChat: () => void;
  isVoiceChatOpen: boolean;
};

const TopBar = memo(
  ({
    onToggleRightSidebar,
    isOpen,
    onToggleVoiceChat,
    isVoiceChatOpen
  }: TTopBarProps) => {
    const isCurrentVoiceChannelSelected = useIsCurrentVoiceChannelSelected();
    const currentVoiceChannelId = useCurrentVoiceChannelId();
    const selectedChannel = useSelectedChannel();
    // The members sidebar uses lg:relative — below 1024px it slides
    // off the right edge regardless of the user's preference. The
    // toggle button stays in the top bar though, so without this flag
    // it'd silently lie about the state. Track the breakpoint and
    // grey out the button + clarify the tooltip when sidebar is
    // unavailable.
    const sidebarAvailable = useViewportAtLeast(1024);
    const [showPinned, setShowPinned] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    const [showThreads, setShowThreads] = useState(false);

    // Dismiss-on-outside-click is anchored to each popover's containing
    // wrapper div (which holds both the toggle button and the popover
    // content). Clicks anywhere inside the wrapper — including the
    // trigger button — don't dismiss; clicks outside do. This avoids
    // the trigger-button-toggling-itself-back-on race we'd hit if the
    // boundary were just the popover content.
    const searchWrapperRef = useRef<HTMLDivElement>(null);
    const pinnedWrapperRef = useRef<HTMLDivElement>(null);
    const threadsWrapperRef = useRef<HTMLDivElement>(null);
    const closeSearch = useCallback(() => setShowSearch(false), []);
    const closePinned = useCallback(() => setShowPinned(false), []);
    const closeThreads = useCallback(() => setShowThreads(false), []);
    useDismissOnOutsideClick(showSearch, searchWrapperRef, closeSearch);
    useDismissOnOutsideClick(showPinned, pinnedWrapperRef, closePinned);
    useDismissOnOutsideClick(showThreads, threadsWrapperRef, closeThreads);

    useEffect(() => {
      const handler = (e: KeyboardEvent) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
          e.preventDefault();
          setShowSearch((prev) => !prev);
        }
      };

      window.addEventListener('keydown', handler);

      return () => window.removeEventListener('keydown', handler);
    }, []);

    return (
      <div className="hidden md:flex h-12 w-full border-b border-border/60 items-center px-4 transition-all duration-300 ease-in-out gap-3">
        {/* Channel info on left */}
        {selectedChannel && (
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {selectedChannel.type === 'TEXT' && (
              <Hash className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
            )}
            {selectedChannel.type === 'VOICE' && (
              <Volume2 className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
            )}
            {selectedChannel.type === 'FORUM' && (
              <LayoutList className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
            )}
            <span className="text-base font-semibold text-foreground truncate">
              {selectedChannel.name}
            </span>
            {selectedChannel.e2ee && (
              <Tooltip content="End-to-end encrypted">
                <Lock className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />
              </Tooltip>
            )}
            {selectedChannel.topic && (
              <>
                <div className="h-4 w-px bg-border/50 mx-1" />
                <span className="text-xs text-muted-foreground/60 truncate">
                  {selectedChannel.topic}
                </span>
              </>
            )}
          </div>
        )}

        {/* Controls on right */}
        <div className="flex items-center gap-1 ml-auto">
          {isCurrentVoiceChannelSelected && currentVoiceChannelId && (
            <>
              <VolumeController channelId={currentVoiceChannelId} />
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleVoiceChat}
                className="h-7 px-2 transition-all duration-200 ease-in-out"
              >
                <Tooltip
                  content={
                    isVoiceChatOpen ? 'Close Voice Chat' : 'Open Voice Chat'
                  }
                  asChild={false}
                >
                  <MessageSquare
                    className={cn(
                      'w-4 h-4 transition-all duration-200 ease-in-out',
                      isVoiceChatOpen && 'fill-current'
                    )}
                  />
                </Tooltip>
              </Button>
            </>
          )}

          {selectedChannel && selectedChannel.type === 'TEXT' && (
            <>
              <div className="relative" ref={searchWrapperRef}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowSearch(!showSearch)}
                  className="h-7 px-2 transition-all duration-200 ease-in-out"
                >
                  <Tooltip content="Search (Ctrl+K)">
                    <div>
                      <Search className={cn('w-4 h-4', showSearch && 'text-primary')} />
                    </div>
                  </Tooltip>
                </Button>
                {showSearch && (
                  <SearchPopover onClose={() => setShowSearch(false)} />
                )}
              </div>
              <div className="relative" ref={pinnedWrapperRef}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowPinned(!showPinned)}
                  className="h-7 px-2 transition-all duration-200 ease-in-out"
                >
                  <Tooltip content="Pinned Messages">
                    <div>
                      <Pin className={cn('w-4 h-4', showPinned && 'fill-current')} />
                    </div>
                  </Tooltip>
                </Button>
                {showPinned && (
                  <PinnedMessagesPanel
                    channelId={selectedChannel.id}
                    onClose={() => setShowPinned(false)}
                  />
                )}
              </div>
              <div className="relative" ref={threadsWrapperRef}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowThreads(!showThreads)}
                  className="h-7 px-2 transition-all duration-200 ease-in-out"
                >
                  <Tooltip content="Threads">
                    <div>
                      <List className={cn('w-4 h-4', showThreads && 'text-primary')} />
                    </div>
                  </Tooltip>
                </Button>
                {showThreads && (
                  <ThreadListPopover
                    channelId={selectedChannel.id}
                    onClose={() => setShowThreads(false)}
                  />
                )}
              </div>
              <NotificationDropdown channelId={selectedChannel.id} />
            </>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleRightSidebar}
            disabled={!sidebarAvailable}
            className={cn(
              'h-7 px-2 transition-all duration-200 ease-in-out',
              !sidebarAvailable && 'opacity-50 cursor-not-allowed'
            )}
          >
            {!sidebarAvailable ? (
              <Tooltip content="Members panel (unavailable — make the window wider)">
                <div>
                  <PanelRight className="w-4 h-4" />
                </div>
              </Tooltip>
            ) : isOpen ? (
              <Tooltip content="Close Members Sidebar">
                <div>
                  <PanelRightClose className="w-4 h-4" />
                </div>
              </Tooltip>
            ) : (
              <Tooltip content="Open Members Sidebar">
                <div>
                  <PanelRight className="w-4 h-4" />
                </div>
              </Tooltip>
            )}
          </Button>
        </div>
      </div>
    );
  }
);

export { TopBar };
