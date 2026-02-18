import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { openServerScreen } from '@/features/server-screens/actions';
import { useCurrentVoiceChannelId } from '@/features/server/channels/hooks';
import { useChannelCan } from '@/features/server/hooks';
import { useOwnPublicUser } from '@/features/server/users/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { getTRPCClient } from '@/lib/trpc';
import { ChannelPermission, UserStatus } from '@pulse/shared';
import { HeadphoneOff, Headphones, Mic, MicOff, Settings } from 'lucide-react';
import { memo, useCallback } from 'react';
import { ServerScreen } from '../server-screens/screens';
import { Button } from '../ui/button';
import { UserAvatar } from '../user-avatar';
import { getStatusLabel, UserStatusBadge } from '../user-status';
import { UserPopover } from '../user-popover';

const statusOptions = [
  UserStatus.ONLINE,
  UserStatus.IDLE,
  UserStatus.DND,
  UserStatus.INVISIBLE
] as const;

const UserControl = memo(() => {
  const ownPublicUser = useOwnPublicUser();
  const currentVoiceChannelId = useCurrentVoiceChannelId();
  const { ownVoiceState, toggleMic, toggleSound } = useVoice();
  const channelCan = useChannelCan(currentVoiceChannelId);

  const handleSettingsClick = useCallback(() => {
    openServerScreen(ServerScreen.USER_SETTINGS);
  }, []);

  const handleStatusChange = useCallback(async (status: (typeof statusOptions)[number]) => {
    const trpc = getTRPCClient();
    await trpc.users.setStatus.mutate({ status });
  }, []);

  if (!ownPublicUser) return null;

  const currentStatus = ownPublicUser.status || UserStatus.OFFLINE;

  return (
    <div className="flex items-center justify-between h-14 px-2 bg-muted border-t border-border">
      <div className="flex items-center space-x-2 min-w-0 flex-1">
        <UserPopover userId={ownPublicUser.id}>
          <div className="cursor-pointer">
            <div className="relative">
              <UserAvatar
                userId={ownPublicUser.id}
                className="h-8 w-8 flex-shrink-0"
                showUserPopover={false}
              />
              <div className="absolute -bottom-0.5 -right-0.5">
                <UserStatusBadge status={currentStatus} className="h-3.5 w-3.5" />
              </div>
            </div>
          </div>
        </UserPopover>
        <div className="flex flex-col min-w-0 flex-1">
          <span className="text-sm font-medium text-foreground truncate">
            {ownPublicUser.name}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="text-xs text-muted-foreground hover:text-foreground transition-colors text-left cursor-pointer">
                {getStatusLabel(currentStatus)}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              {statusOptions.map((status) => (
                <DropdownMenuItem
                  key={status}
                  onClick={() => handleStatusChange(status)}
                  className="flex items-center gap-2"
                >
                  <UserStatusBadge status={status} className="h-3 w-3" />
                  <span>{getStatusLabel(status)}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex items-center space-x-0.5">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 hover:bg-muted/50',
            ownVoiceState.micMuted
              ? 'text-red-500 hover:text-red-400 bg-red-500/10 hover:bg-red-500/20'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={toggleMic}
          title={
            ownVoiceState.micMuted
              ? 'Unmute microphone (Ctrl+Shift+M)'
              : 'Mute microphone (Ctrl+Shift+M)'
          }
          disabled={!channelCan(ChannelPermission.SPEAK)}
        >
          {ownVoiceState.micMuted ? (
            <MicOff className="h-4 w-4" />
          ) : (
            <Mic className="h-4 w-4" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-8 w-8 hover:bg-muted/50',
            ownVoiceState.soundMuted
              ? 'text-red-500 hover:text-red-400 bg-red-500/10 hover:bg-red-500/20'
              : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={toggleSound}
          title={
            ownVoiceState.soundMuted
              ? 'Undeafen (Ctrl+Shift+D)'
              : 'Deafen (Ctrl+Shift+D)'
          }
        >
          {ownVoiceState.soundMuted ? (
            <HeadphoneOff className="h-4 w-4" />
          ) : (
            <Headphones className="h-4 w-4" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground hover:bg-muted/50"
          onClick={handleSettingsClick}
          title="User settings"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
});

export { UserControl };
