import { ScreenShareCard } from '@/components/channel-view/voice/screen-share-card';
import { VoiceGrid } from '@/components/channel-view/voice/voice-grid';
import { VoiceUserCard } from '@/components/channel-view/voice/voice-user-card';
import {
  PinnedCardType,
  usePinCardController
} from '@/components/channel-view/voice/hooks/use-pin-card-controller';
import { useVoice } from '@/features/server/voice/hooks';
import { useVoiceUsersByChannelId } from '@/features/server/hooks';
import { cn } from '@/lib/utils';
import { ChannelPermission } from '@pulse/shared';
import { useChannelCan } from '@/features/server/hooks';
import { Monitor, MonitorOff, Video, VideoOff } from 'lucide-react';
import { memo, useMemo } from 'react';
import { Button } from '@/components/ui/button';

type TDmVoicePanelProps = {
  dmChannelId: number;
};

const DmVoicePanel = memo(({ dmChannelId }: TDmVoicePanelProps) => {
  const voiceUsers = useVoiceUsersByChannelId(dmChannelId);
  const { pinnedCard, pinCard, unpinCard, isPinned } = usePinCardController();
  const { ownVoiceState, toggleWebcam, toggleScreenShare } = useVoice();
  const channelCan = useChannelCan(dmChannelId);

  const cards = useMemo(() => {
    const cards: React.ReactNode[] = [];

    voiceUsers.forEach((voiceUser) => {
      const userCardId = `user-${voiceUser.id}`;

      cards.push(
        <VoiceUserCard
          key={userCardId}
          userId={voiceUser.id}
          isPinned={isPinned(userCardId)}
          onPin={() =>
            pinCard({
              id: userCardId,
              type: PinnedCardType.USER,
              userId: voiceUser.id
            })
          }
          onUnpin={unpinCard}
          voiceUser={voiceUser}
        />
      );

      if (voiceUser.state.sharingScreen) {
        const screenShareCardId = `screen-share-${voiceUser.id}`;

        cards.push(
          <ScreenShareCard
            key={screenShareCardId}
            userId={voiceUser.id}
            isPinned={isPinned(screenShareCardId)}
            onPin={() =>
              pinCard({
                id: screenShareCardId,
                type: PinnedCardType.SCREEN_SHARE,
                userId: voiceUser.id
              })
            }
            onUnpin={unpinCard}
            showPinControls
          />
        );
      }
    });

    return cards;
  }, [voiceUsers, isPinned, pinCard, unpinCard]);

  if (voiceUsers.length === 0) return null;

  return (
    <div className="flex flex-col border-b border-border bg-background/50">
      <div className="h-[40vh] min-h-[200px] relative overflow-hidden">
        <VoiceGrid pinnedCardId={pinnedCard?.id} className="h-full">
          {cards}
        </VoiceGrid>
      </div>

      <div className="flex items-center justify-center gap-2.5 px-3 py-2.5 border-t border-border bg-secondary/30">
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-9 w-9 rounded-lg transition-all duration-200',
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
          disabled={!channelCan(ChannelPermission.WEBCAM)}
        >
          {ownVoiceState.webcamEnabled ? (
            <Video className="h-4 w-4" />
          ) : (
            <VideoOff className="h-4 w-4" />
          )}
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className={cn(
            'h-9 w-9 rounded-lg transition-all duration-200',
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
          disabled={!channelCan(ChannelPermission.SHARE_SCREEN)}
        >
          {ownVoiceState.sharingScreen ? (
            <Monitor className="h-4 w-4" />
          ) : (
            <MonitorOff className="h-4 w-4" />
          )}
        </Button>
      </div>
    </div>
  );
});

export { DmVoicePanel };
