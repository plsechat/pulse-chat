import {
  useCurrentVoiceChannelId,
  useCurrentVoiceKind
} from '@/features/server/channels/hooks';
import { useChannelCan } from '@/features/server/hooks';
import { leaveCurrentVoice } from '@/features/server/voice/actions';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { ChannelPermission } from '@pulse/shared';
import {
  AlertTriangle,
  Loader2,
  Monitor,
  MonitorOff,
  PhoneOff,
  Video,
  VideoOff,
  Wifi,
  WifiOff
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { SoundboardPopover } from '../soundboard/soundboard-popover';
import { WatchTogetherButton } from '../soundboard/watch-together-button';
import { Button } from '../ui/button';
import { StatsPopover } from './stats-popover';

const alwaysAllowed = () => true;

/** Phones have no screen capture; the button only produced a failure
 *  toast there. Capability, not device sniffing. */
const canShareScreen = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.mediaDevices?.getDisplayMedia === 'function';

const VoiceControl = memo(() => {
  const voiceChannelId = useCurrentVoiceChannelId();
  const voiceKind = useCurrentVoiceKind();
  // Channel permissions exist for server channels only; a DM call has
  // none, and looking its id up among the server's channels found an
  // unrelated channel with the same number.
  const channelCan = useChannelCan(
    voiceKind === 'channel' ? voiceChannelId : undefined
  );
  const can = voiceKind === 'dm' ? alwaysAllowed : channelCan;
  const { ownVoiceState, toggleWebcam, toggleScreenShare, connectionStatus } =
    useVoice();

  const connectionInfo = useMemo(() => {
    switch (connectionStatus) {
      case 'connecting':
        return {
          icon: <Loader2 className="h-4 w-4 animate-spin" />,
          text: 'Connecting...',
          color: 'text-yellow-500'
        };
      case 'connected':
        return {
          icon: <Wifi className="h-4 w-4 text-green-600" />,
          text: 'Voice connected',
          color: 'text-green-600'
        };
      case 'failed':
        return {
          icon: <AlertTriangle className="h-4 w-4 text-red-500" />,
          text: 'Connection failed',
          color: 'text-red-500'
        };
      case 'disconnected':
      default:
        return {
          icon: <WifiOff className="h-4 w-4 text-red-500" />,
          text: 'Disconnected',
          color: 'text-red-500'
        };
    }
  }, [connectionStatus]);

  if (!voiceChannelId) {
    return null;
  }

  return (
    <div className="bg-secondary/30">
      <StatsPopover>
        <div className="flex items-center px-2 py-1.5 gap-2 bg-secondary/50 cursor-pointer hover:bg-secondary/60 transition-colors">
          {connectionInfo.icon}
          <span className={cn('text-xs font-medium', connectionInfo.color)}>
            {connectionInfo.text}
          </span>
        </div>
      </StatsPopover>

      {/* Five 32 px controls and four 4 px gaps: 176 px, inside the
          208 px the deck card offers. The labelled Disconnect of before
          (122 px on its own) pushed the share button under the card's
          overflow-hidden edge. Icon-only, like the phone in-call bar. */}
      <div className="flex items-center gap-1 px-2 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="bg-secondary text-red-400 hover:bg-red-500/15 hover:text-red-300"
          onClick={() => void leaveCurrentVoice()}
          aria-label="Disconnect"
          title="Disconnect"
        >
          <PhoneOff className="h-4 w-4" />
        </Button>

        <div className="ml-auto flex items-center gap-1">
          <SoundboardPopover />
          <WatchTogetherButton />
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              'rounded-md transition-all duration-200',
              ownVoiceState.webcamEnabled
                ? 'bg-green-500/15 hover:bg-green-500/25 text-green-400 hover:text-green-300'
                : 'bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground'
            )}
            onClick={toggleWebcam}
            title={
              ownVoiceState.webcamEnabled
                ? 'Turn off camera'
                : 'Turn on camera'
            }
            disabled={!can(ChannelPermission.WEBCAM)}
          >
            {ownVoiceState.webcamEnabled ? (
              <Video className="h-4 w-4" />
            ) : (
              <VideoOff className="h-4 w-4" />
            )}
          </Button>

          {canShareScreen() && (
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                'rounded-md transition-all duration-200',
                ownVoiceState.sharingScreen
                  ? 'bg-blue-500/15 hover:bg-blue-500/25 text-blue-400 hover:text-blue-300'
                  : 'bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground'
              )}
              onClick={toggleScreenShare}
              title={
                ownVoiceState.sharingScreen
                  ? 'Stop screen share'
                  : 'Start screen share'
              }
              disabled={!can(ChannelPermission.SHARE_SCREEN)}
            >
              {/* Share is an action, not a device state: a plain monitor
                  offers to start, the struck one to stop. */}
              {ownVoiceState.sharingScreen ? (
                <MonitorOff className="h-4 w-4" />
              ) : (
                <Monitor className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

export { VoiceControl };
