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
import { getNameStyleCss } from '@/helpers/name-style';
import { cn } from '@/lib/utils';
import { getTRPCClient } from '@/lib/trpc';
import { StreamKind, VOICE_STREAM_PREVIEW_INTERVAL_MS } from '@pulse/shared';
import {
  HeadphoneOff,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  Video,
  Volume2,
  VolumeX
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const STREAM_PREVIEW_HOVER_DELAY_MS = 350;
// Approximate card height; clamps the portal against the viewport bottom
const STREAM_PREVIEW_CARD_HEIGHT = 160;

type TStreamPreviewCardProps = {
  channelId: number;
  userId: number;
  anchor: DOMRect;
};

/**
 * Floating live thumbnail of a user's screen share, portal-rendered to
 * the right of the roster row. A manual portal instead of a Radix
 * Tooltip: the row already stacks ContextMenu > Popover asChild triggers
 * and a third nested trigger renders unreliably there.
 */
const StreamPreviewCard = memo(
  ({ channelId, userId, anchor }: TStreamPreviewCardProps) => {
    const [preview, setPreview] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
      let cancelled = false;

      const fetchPreview = async () => {
        try {
          const trpc = getTRPCClient();
          if (!trpc) return;

          const result = await trpc.voice.getStreamPreview.query({
            channelId,
            userId
          });

          if (cancelled) return;
          setPreview(result.preview);
        } catch {
          // Background poll — never toast; the card just shows fallback
        } finally {
          if (!cancelled) setLoading(false);
        }
      };

      void fetchPreview();
      const interval = window.setInterval(
        fetchPreview,
        VOICE_STREAM_PREVIEW_INTERVAL_MS
      );

      return () => {
        cancelled = true;
        window.clearInterval(interval);
      };
    }, [channelId, userId]);

    const top = Math.max(
      8,
      Math.min(anchor.top, window.innerHeight - STREAM_PREVIEW_CARD_HEIGHT)
    );

    return createPortal(
      <div
        className="pointer-events-none fixed z-50"
        style={{ left: anchor.right + 8, top }}
      >
        <div className="w-64 rounded-md border border-border bg-popover p-1 shadow-md">
          {loading ? (
            <div className="flex h-36 items-center justify-center">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : preview ? (
            <div className="relative">
              <img
                src={preview}
                alt="Live stream preview"
                className="w-full rounded"
              />
              <span className="absolute bottom-1.5 left-1.5 rounded bg-red-600/90 px-1 py-px text-[10px] font-semibold leading-tight text-white">
                LIVE
              </span>
            </div>
          ) : (
            <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">
              No preview yet
            </div>
          )}
        </div>
      </div>,
      document.body
    );
  }
);

type TVoiceUserProps = {
  userId: number;
  user: TVoiceUser;
  channelId: number;
};

const VoiceUser = memo(({ user, channelId }: TVoiceUserProps) => {
  const { remoteUserStreams, localAudioStream } = useVoice();
  const ownUserId = useOwnUserId();
  const isOwnUser = user.id === ownUserId;
  const { getVolume, setVolume, toggleMute, getUserVolumeKey } =
    useVolumeControl();

  const sharingScreen = user.state.sharingScreen;
  const hoverTimerRef = useRef<number | null>(null);
  const [previewAnchor, setPreviewAnchor] = useState<DOMRect | null>(null);

  const closePreview = useCallback(() => {
    if (hoverTimerRef.current !== null) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setPreviewAnchor(null);
  }, []);

  const handleRowMouseEnter = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!sharingScreen) return;

      const target = e.currentTarget;
      if (hoverTimerRef.current !== null) {
        window.clearTimeout(hoverTimerRef.current);
      }
      hoverTimerRef.current = window.setTimeout(() => {
        hoverTimerRef.current = null;
        setPreviewAnchor(target.getBoundingClientRect());
      }, STREAM_PREVIEW_HOVER_DELAY_MS);
    },
    [sharingScreen]
  );

  // Sharing stopped while the card was open (or pending)
  useEffect(() => {
    if (!sharingScreen) closePreview();
  }, [sharingScreen, closePreview]);

  useEffect(() => closePreview, [closePreview]);

  const volumeKey = getUserVolumeKey(user.id);
  const volume = getVolume(volumeKey);
  const isMuted = volume === 0;

  const audioStream = useMemo(() => {
    if (isOwnUser) return localAudioStream;
    return remoteUserStreams[user.id]?.[StreamKind.AUDIO];
  }, [remoteUserStreams, user.id, isOwnUser, localAudioStream]);

  const { isSpeaking } = useAudioLevel(audioStream);
  const isActivelySpeaking = !user.state.micMuted && isSpeaking;
  const nameCss = getNameStyleCss(user.nameStyle);

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
    <div
      className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/30 text-sm cursor-pointer"
      onMouseEnter={handleRowMouseEnter}
      onMouseLeave={closePreview}
      // Opening the volume popover / context menu dismisses the preview
      onMouseDown={closePreview}
    >
      <UserAvatar
        userId={user.id}
        className="h-5 w-5"
        showUserPopover={false}
        showStatusBadge={false}
      />

      <span
        className={cn(
          'flex-1 truncate text-xs transition-colors duration-150',
          // The speaking flash is a state indicator — it suppresses the
          // cosmetic style while active.
          !isActivelySpeaking && nameCss?.className
        )}
        style={
          isActivelySpeaking
            ? { color: 'rgb(34, 197, 94)' }
            : nameCss?.style
        }
      >
        {getDisplayName(user)}
      </span>

      <div className="flex items-center gap-1 opacity-60">
        <div title={user.state.serverMuted ? 'Muted by a moderator' : undefined}>
          {user.state.serverMuted || user.state.micMuted ? (
            <MicOff
              className={
                user.state.serverMuted
                  ? 'h-3 w-3 text-red-600'
                  : 'h-3 w-3 text-red-500'
              }
            />
          ) : (
            <Mic className="h-3 w-3 text-green-500" />
          )}
        </div>

        <div title={user.state.serverDeafened ? 'Deafened by a moderator' : undefined}>
          {user.state.serverDeafened || user.state.soundMuted ? (
            <HeadphoneOff
              className={
                user.state.serverDeafened
                  ? 'h-3 w-3 text-red-600'
                  : 'h-3 w-3 text-red-500'
              }
            />
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
    <>
      {sharingScreen && previewAnchor && (
        <StreamPreviewCard
          channelId={channelId}
          userId={user.id}
          anchor={previewAnchor}
        />
      )}
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
    </>
  );
});

export { VoiceUser };
