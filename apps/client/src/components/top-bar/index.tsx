import { Button } from '@/components/ui/button';
import {
  useCurrentVoiceChannelId,
  useIsCurrentVoiceChannelSelected,
  useSelectedChannel
} from '@/features/server/channels/hooks';
import { cn } from '@/lib/utils';
import { Hash, LayoutList, List, MessageSquare, PanelRight, PanelRightClose, Pin, Search, Volume2 } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
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
    const [showPinned, setShowPinned] = useState(false);
    const [showSearch, setShowSearch] = useState(false);
    const [showThreads, setShowThreads] = useState(false);

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
      <div className="hidden md:flex h-12 w-full border-b border-border items-center px-4 transition-all duration-300 ease-in-out gap-3 shadow-[0_1px_0_rgba(0,0,0,0.2)]">
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
              <div className="relative">
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
              <div className="relative">
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
              <div className="relative">
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
            className="h-7 px-2 transition-all duration-200 ease-in-out"
          >
            {isOpen ? (
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
