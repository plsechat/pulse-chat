import { useSelectedChannel } from '@/features/server/channels/hooks';
import { Hash, LayoutList, Menu, Users, Volume2 } from 'lucide-react';
import { memo } from 'react';
import { Button } from '../ui/button';

type TMobileHeaderProps = {
  onToggleLeftDrawer: () => void;
  onToggleRightDrawer?: () => void;
  title?: string;
};

const MobileHeader = memo(
  ({ onToggleLeftDrawer, onToggleRightDrawer, title }: TMobileHeaderProps) => {
    const selectedChannel = useSelectedChannel();

    const channelName = title || selectedChannel?.name;
    const channelType = selectedChannel?.type;

    return (
      <div className="flex md:hidden h-12 w-full border-b border-border items-center px-2 gap-1 bg-background">
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          onClick={onToggleLeftDrawer}
        >
          <Menu className="h-5 w-5" />
        </Button>

        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {!title && channelType === 'TEXT' && (
            <Hash className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
          )}
          {!title && channelType === 'VOICE' && (
            <Volume2 className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
          )}
          {!title && channelType === 'FORUM' && (
            <LayoutList className="h-4 w-4 text-muted-foreground/60 flex-shrink-0" />
          )}
          {channelName && (
            <span className="text-sm font-semibold text-foreground truncate">
              {channelName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-0.5">
          {onToggleRightDrawer && (
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 flex-shrink-0"
              onClick={onToggleRightDrawer}
            >
              <Users className="h-5 w-5" />
            </Button>
          )}
        </div>
      </div>
    );
  }
);

export { MobileHeader };
