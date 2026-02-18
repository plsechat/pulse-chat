import { UserContextMenu } from '@/components/context-menus/user';
import { UserAvatar } from '@/components/user-avatar';
import { UserPopover } from '@/components/user-popover';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import type { TVoiceUser } from '@/features/server/types';
import { useOwnUserId } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { HeadphoneOff, MicOff, Monitor, Video } from 'lucide-react';
import { memo, useCallback } from 'react';
import { CardControls } from './card-controls';
import { CardGradient } from './card-gradient';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { VolumeButton } from './volume-button';

type TVoiceUserCardProps = {
  userId: number;
  onPin: () => void;
  onUnpin: () => void;
  showPinControls?: boolean;
  voiceUser: TVoiceUser;
  className?: string;
  isPinned?: boolean;
};

const VoiceUserCard = memo(
  ({
    userId,
    onPin,
    onUnpin,
    className,
    isPinned = false,
    showPinControls = true,
    voiceUser
  }: TVoiceUserCardProps) => {
    const { videoRef, hasVideoStream, isSpeaking, speakingIntensity } =
      useVoiceRefs(userId);
    const { getUserVolumeKey } = useVolumeControl();
    const ownUserId = useOwnUserId();
    const isOwnUser = userId === ownUserId;

    const handlePinToggle = useCallback(() => {
      if (isPinned) {
        onUnpin?.();
      } else {
        onPin?.();
      }
    }, [isPinned, onPin, onUnpin]);

    const isActivelySpeaking = !voiceUser.state.micMuted && isSpeaking;

    return (
      <UserContextMenu userId={userId}>
        <UserPopover userId={userId}>
          <div
            className={cn(
              'relative bg-card rounded-lg overflow-hidden group',
              'flex items-center justify-center',
              'w-full h-full',
              'border border-border',
              isActivelySpeaking
                ? speakingIntensity === 1
                  ? 'speaking-effect-low'
                  : speakingIntensity === 2
                    ? 'speaking-effect-medium'
                    : 'speaking-effect-high'
                : '',
              className
            )}
          >
            <CardGradient />

            <CardControls>
              {!isOwnUser && <VolumeButton volumeKey={getUserVolumeKey(userId)} />}
              {showPinControls && (
                <PinButton isPinned={isPinned} handlePinToggle={handlePinToggle} />
              )}
            </CardControls>

            {hasVideoStream && (
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className="absolute inset-0 w-full h-full object-cover"
              />
            )}
            {!hasVideoStream && (
              <UserAvatar
                userId={userId}
                className="w-12 h-12 md:w-16 md:h-16 lg:w-24 lg:h-24"
                showStatusBadge={false}
              />
            )}

            <div className="absolute bottom-0 left-0 right-0 p-2.5">
              <div className="flex items-center justify-between gap-1.5">
                <span className="text-white font-medium text-xs truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.5)]">
                  {voiceUser.name}
                </span>

                <div className="flex items-center gap-1">
                  {voiceUser.state.micMuted && (
                    <div className="h-5 w-5 rounded-full bg-red-500/30 backdrop-blur-sm flex items-center justify-center">
                      <MicOff className="size-3 text-red-400" />
                    </div>
                  )}

                  {voiceUser.state.soundMuted && (
                    <div className="h-5 w-5 rounded-full bg-red-500/30 backdrop-blur-sm flex items-center justify-center">
                      <HeadphoneOff className="size-3 text-red-400" />
                    </div>
                  )}

                  {voiceUser.state.webcamEnabled && (
                    <div className="h-5 w-5 rounded-full bg-blue-500/30 backdrop-blur-sm flex items-center justify-center">
                      <Video className="size-3 text-blue-400" />
                    </div>
                  )}

                  {voiceUser.state.sharingScreen && (
                    <div className="h-5 w-5 rounded-full bg-purple-500/30 backdrop-blur-sm flex items-center justify-center">
                      <Monitor className="size-3 text-purple-400" />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </UserPopover>
      </UserContextMenu>
    );
  }
);

VoiceUserCard.displayName = 'VoiceUserCard';

export { VoiceUserCard };
