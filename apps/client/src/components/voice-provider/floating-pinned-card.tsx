import { setSelectedChannelId } from '@/features/server/channels/actions';
import {
  useCurrentVoiceChannelId,
  useIsCurrentVoiceChannelSelected
} from '@/features/server/channels/hooks';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { usePinnedCard } from '@/features/server/voice/hooks';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { cn } from '@/lib/utils';
import type { TRemoteStreams } from '@/types';
import { ArrowDownLeft, SendToBack, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CardControls } from '../channel-view/voice/card-controls';
import { PinnedCardType } from '../channel-view/voice/hooks/use-pin-card-controller';
import { IconButton } from '../ui/icon-button';
import { useFloatingCard } from './hooks/use-floating-card';
import type { TExternalStreamsMap } from './hooks/use-remote-streams';

type TFloatingPinnedCardProps = {
  remoteUserStreams: TRemoteStreams;
  externalStreams: TExternalStreamsMap;
  localVideoStream: MediaStream | undefined;
  localScreenShareStream: MediaStream | undefined;
};

const FloatingPinnedCard = memo(
  ({
    remoteUserStreams,
    externalStreams,
    localVideoStream,
    localScreenShareStream
  }: TFloatingPinnedCardProps) => {
    const { cardRef, dragHandlers, getStyle, resetCard } = useFloatingCard();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [open, setOpen] = useState(true);
    const pinnedCard = usePinnedCard();
    const ownUserId = useOwnUserId();
    const currentVoiceChannelSelected = useCurrentVoiceChannelId();
    const isCurrentVoiceChannelSelected = useIsCurrentVoiceChannelSelected();
    const pinnedUser = useUserById(pinnedCard?.userId || -1);
    // Phones: a w-96 card (wider than the screen) that only a mouse
    // could move or close covered the composer. Below `md` the card is
    // a small tile docked above the composer, in the bottom-right, with
    // its controls always visible and no drag.
    const isMobile = useIsMobile();

    const isExternalStream =
      pinnedCard?.type === PinnedCardType.EXTERNAL_STREAM;

    const pinnedCardVideoStream = useMemo(() => {
      if (!pinnedCard) return undefined;

      if (isExternalStream) {
        const externalStream = externalStreams[pinnedCard.userId];

        return externalStream?.videoStream;
      }

      if (pinnedCard.userId === ownUserId) {
        return localScreenShareStream || localVideoStream || undefined;
      }

      const streamInfo = remoteUserStreams[pinnedCard.userId];

      if (!streamInfo) return undefined;

      return streamInfo.screen || streamInfo.video || undefined;
    }, [
      pinnedCard,
      remoteUserStreams,
      externalStreams,
      ownUserId,
      localVideoStream,
      localScreenShareStream,
      isExternalStream
    ]);

    const onCloseClick = useCallback(() => {
      setOpen(false);
    }, []);

    const onGoToVoiceChannelClick = useCallback(() => {
      setSelectedChannelId(currentVoiceChannelSelected);
    }, [currentVoiceChannelSelected]);

    useEffect(() => {
      if (videoRef.current && pinnedCardVideoStream) {
        videoRef.current.srcObject = pinnedCardVideoStream;
      }
    }, [pinnedCardVideoStream, isCurrentVoiceChannelSelected]);

    useEffect(() => {
      setOpen(true);
    }, [pinnedCard?.id, isCurrentVoiceChannelSelected]);

    if (!pinnedCardVideoStream || isCurrentVoiceChannelSelected || !open) {
      return null;
    }

    return (
      <div
        ref={cardRef}
        {...(isMobile ? {} : dragHandlers)}
        className={cn(
          'z-50 select-none aspect-video rounded-lg overflow-hidden border border-border bg-black shadow-lg group',
          isMobile
            ? 'fixed right-2 bottom-[calc(3.5rem+env(safe-area-inset-bottom)+4.5rem)] w-48'
            : 'absolute w-96 cursor-move touch-none'
        )}
        style={isMobile ? undefined : getStyle()}
        data-testid="floating-pinned-card"
      >
        <CardControls>
          <IconButton
            icon={ArrowDownLeft}
            size="sm"
            variant="ghost"
            title="Go To Voice Channel"
            aria-label="Go To Voice Channel"
            onClick={onGoToVoiceChannelClick}
          />
          {!isMobile && (
            <IconButton
              icon={SendToBack}
              size="sm"
              variant="ghost"
              title="Reset Position"
              aria-label="Reset Position"
              onClick={resetCard}
            />
          )}
          <IconButton
            icon={X}
            size="sm"
            variant="ghost"
            title="Close"
            aria-label="Close"
            onClick={onCloseClick}
          />
        </CardControls>

        {pinnedUser && (
          <div className="absolute bottom-2 left-2 bg-black/50 rounded-md px-2 py-1 text-xs z-10 opacity-0 group-hover-or-touch:opacity-100 transition-opacity">
            {pinnedUser.name}
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain"
        />
      </div>
    );
  }
);

FloatingPinnedCard.displayName = 'FloatingPinnedCard';

export { FloatingPinnedCard };
