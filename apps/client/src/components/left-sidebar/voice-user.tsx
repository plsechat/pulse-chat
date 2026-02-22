import { UserContextMenu } from '@/components/context-menus/user';
import { UserAvatar } from '@/components/user-avatar';
import { useAudioLevel } from '@/components/channel-view/voice/hooks/use-audio-level';
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
  Video
} from 'lucide-react';
import { memo, useMemo } from 'react';

type TVoiceUserProps = {
  userId: number;
  user: TVoiceUser;
};

const VoiceUser = memo(({ user }: TVoiceUserProps) => {
  const { remoteUserStreams, localAudioStream } = useVoice();
  const ownUserId = useOwnUserId();
  const isOwnUser = user.id === ownUserId;

  const audioStream = useMemo(() => {
    if (isOwnUser) return localAudioStream;
    return remoteUserStreams[user.id]?.[StreamKind.AUDIO];
  }, [remoteUserStreams, user.id, isOwnUser, localAudioStream]);

  const { isSpeaking } = useAudioLevel(audioStream);
  const isActivelySpeaking = !user.state.micMuted && isSpeaking;

  return (
    <UserContextMenu userId={user.id}>
      <div className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/30 text-sm">
        <UserAvatar
          userId={user.id}
          className="h-5 w-5"
          showUserPopover={true}
          showStatusBadge={false}
        />

        <span
          className="flex-1 truncate text-xs transition-colors duration-150"
          style={isActivelySpeaking ? { color: 'rgb(34, 197, 94)' } : undefined}
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
    </UserContextMenu>
  );
});

export { VoiceUser };
