import { UserContextMenu } from '@/components/context-menus/user';
import { UserAvatar } from '@/components/user-avatar';
import { useAudioLevel } from '@/components/channel-view/voice/hooks/use-audio-level';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { useVoice } from '@/features/server/voice/hooks';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { getDisplayName } from '@/helpers/get-display-name';
import { StreamKind } from '@pulse/shared';
import {
  HeadphoneOff,
  Headphones,
  Mic,
  MicOff,
  Monitor,
  Video,
  Volume2,
  VolumeX
} from 'lucide-react';
import { memo, useCallback, useMemo } from 'react';

type TVoiceUserProps = {
  userId: number;
  user: TVoiceUser;
};

const VoiceUser = memo(({ user }: TVoiceUserProps) => {
  const { remoteUserStreams, localAudioStream } = useVoice();
  const ownUserId = useOwnUserId();
  const isOwnUser = user.id === ownUserId;
  const { getVolume, setVolume, toggleMute, getUserVolumeKey } =
    useVolumeControl();

  const volumeKey = getUserVolumeKey(user.id);
  const volume = getVolume(volumeKey);
  const isMuted = volume === 0;

  const audioStream = useMemo(() => {
    if (isOwnUser) return localAudioStream;
    return remoteUserStreams[user.id]?.[StreamKind.AUDIO];
  }, [remoteUserStreams, user.id, isOwnUser, localAudioStream]);

  const { isSpeaking } = useAudioLevel(audioStream);
  const isActivelySpeaking = !user.state.micMuted && isSpeaking;

  const handleVolumeChange = useCallback(
    (values: number[]) => {
      setVolume(volumeKey, values[0] || 0);
    },
    [volumeKey, setVolume]
  );

  const handleToggleMute = useCallback(() => {
    toggleMute(volumeKey);
  }, [volumeKey, toggleMute]);

  const row = (
    <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/30 text-sm cursor-pointer">
      <UserAvatar
        userId={user.id}
        className="h-5 w-5"
        showUserPopover={false}
        showStatusBadge={false}
      />

      <span
        className="flex-1 truncate text-xs transition-colors duration-150"
        style={
          isActivelySpeaking ? { color: 'rgb(34, 197, 94)' } : undefined
        }
      >
        {getDisplayName(user)}
      </span>

      <div className="flex items-center gap-1 opacity-60">
        <div>
          {user.state.micMuted ? (
            <MicOff className="h-3 w-3 text-red-500" />
          ) : (
            <Mic className="h-3 w-3 text-green-500" />
          )}
        </div>

        <div>
          {user.state.soundMuted ? (
            <HeadphoneOff className="h-3 w-3 text-red-500" />
          ) : (
            <Headphones className="h-3 w-3 text-green-500" />
          )}
        </div>

        {user.state.webcamEnabled && (
          <Video className="h-3 w-3 text-blue-500" />
        )}

        {user.state.sharingScreen && (
          <Monitor className="h-3 w-3 text-purple-500" />
        )}
      </div>
    </div>
  );

  return (
    <UserContextMenu userId={user.id}>
      {isOwnUser ? (
        row
      ) : (
        <Popover>
          <PopoverTrigger asChild>{row}</PopoverTrigger>
          <PopoverContent
            align="start"
            side="right"
            className="w-52 p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                User Volume
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleToggleMute}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isMuted ? (
                    <VolumeX className="h-4 w-4 text-red-500" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </button>
                <Slider
                  value={[volume]}
                  onValueChange={handleVolumeChange}
                  min={0}
                  max={100}
                  step={1}
                  className="flex-1 cursor-pointer"
                />
                <span className="text-xs text-muted-foreground w-8 text-right">
                  {volume}%
                </span>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </UserContextMenu>
  );
});

export { VoiceUser };
