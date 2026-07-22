import { useDevices } from '@/components/devices-provider/hooks/use-devices';
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Slider } from '@/components/ui/slider';
import { useVolumeControl } from '@/components/voice-provider/volume-control-context';
import { useOwnUserId, useUserById } from '@/features/server/users/hooks';
import { useVoice } from '@/features/server/voice/hooks';
import { cn } from '@/lib/utils';
import { Resolution } from '@/types';
import {
  Maximize,
  Minimize,
  Monitor,
  MonitorUp,
  ScreenShareOff,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut
} from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { CardControls } from './card-controls';
import { CardGradient } from './card-gradient';
import { useCardClickFocus } from './hooks/use-card-click-focus';
import { useScreenShareZoom } from './hooks/use-screen-share-zoom';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';
import { VolumeButton } from './volume-button';

const QUALITY_RESOLUTIONS = [Resolution['720p'], Resolution['1080p']];
const QUALITY_FRAMERATES = [15, 30, 60];

type tScreenShareControlsProps = {
  isPinned: boolean;
  isZoomEnabled: boolean;
  handlePinToggle: () => void;
  handleToggleZoom: () => void;
  showPinControls: boolean;
};

const ScreenShareControls = memo(
  ({
    isPinned,
    isZoomEnabled,
    handlePinToggle,
    handleToggleZoom,
    showPinControls
  }: tScreenShareControlsProps) => {
    return (
      <CardControls>
        {showPinControls && isPinned && (
          <IconButton
            variant={isZoomEnabled ? 'default' : 'ghost'}
            icon={isZoomEnabled ? ZoomOut : ZoomIn}
            onClick={handleToggleZoom}
            title={isZoomEnabled ? 'Disable Zoom' : 'Enable Zoom'}
            size="sm"
          />
        )}
        {showPinControls && (
          <PinButton isPinned={isPinned} handlePinToggle={handlePinToggle} />
        )}
      </CardControls>
    );
  }
);

type TQuickBarProps = {
  children?: React.ReactNode;
};

// Enlarged, padded, hover-highlighted hit target for the QuickBar. The
// bare-glyph default (size-4, no padding) was too small to click on a
// video overlay — this gives a ~48px circular target with a hover ring.
const QUICK_BTN = 'rounded-full p-2.5 hover:bg-white/15';

/**
 * Bottom-center hover pill hosting the tile's quick actions. Mirrors
 * CardControls' propagation stops so the buttons never feed the
 * container's zoom-pan / click-focus / double-click handlers.
 */
const QuickBar = memo(({ children }: TQuickBarProps) => {
  return (
    <div
      className={cn(
        'absolute bottom-2 left-1/2 -translate-x-1/2 z-20',
        'opacity-0 group-hover:opacity-100 transition-opacity',
        'flex items-center gap-1 rounded-full bg-black/60 backdrop-blur-sm px-1.5 py-1',
        'pointer-events-auto cursor-default'
      )}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseMove={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {children}
    </div>
  );
});

type TScreenShareCardProps = {
  userId: number;
  isPinned?: boolean;
  onPin: () => void;
  onUnpin: () => void;
  className?: string;
  showPinControls: boolean;
};

const ScreenShareCard = memo(
  ({
    userId,
    isPinned = false,
    onPin,
    onUnpin,
    className,
    showPinControls = true
  }: TScreenShareCardProps) => {
    const user = useUserById(userId);
    const { screenShareRef, hasScreenShareStream, hasScreenShareAudioStream } =
      useVoiceRefs(userId);
    const ownUserId = useOwnUserId();
    const isOwnUser = userId === ownUserId;

    const {
      toggleScreenShare,
      changeScreenShare,
      screenAudioMuted,
      toggleScreenShareAudio,
      localScreenShareStream
    } = useVoice();
    const { getScreenVolumeKey, getVolume, setVolume, toggleMute } =
      useVolumeControl();
    const { devices, saveDevices } = useDevices();

    const screenVolumeKey = getScreenVolumeKey(userId);
    const screenVolume = getVolume(screenVolumeKey);
    const isScreenAudioMuted = screenVolume === 0;
    // Reactive "this share carries audio" for the OWN tile — the stream
    // object is replaced on every start/source change.
    const hasOutgoingScreenAudio =
      isOwnUser && (localScreenShareStream?.getAudioTracks().length ?? 0) > 0;

    const {
      containerRef,
      isZoomEnabled,
      zoom,
      position,
      isDragging,
      handleToggleZoom,
      handleWheel,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      getCursor,
      resetZoom
    } = useScreenShareZoom();

    const handlePinToggle = useCallback(() => {
      if (isPinned) {
        onUnpin?.();
        resetZoom();
      } else {
        onPin?.();
      }
    }, [isPinned, onPin, onUnpin, resetZoom]);

    const {
      handleClickMouseDown,
      handleClickMouseUp,
      cancelClick,
      wasJustFocusedByClick
    } = useCardClickFocus(isPinned, onPin);

    const handleContainerMouseDown = useCallback(
      (e: React.MouseEvent) => {
        handleMouseDown(e);
        handleClickMouseDown(e);
      },
      [handleMouseDown, handleClickMouseDown]
    );

    const handleContainerMouseUp = useCallback(
      (e: React.MouseEvent) => {
        handleMouseUp();
        handleClickMouseUp(e);
      },
      [handleMouseUp, handleClickMouseUp]
    );

    const handleContainerMouseLeave = useCallback(() => {
      handleMouseUp();
      cancelClick();
    }, [handleMouseUp, cancelClick]);

    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
      const handleFullscreenChange = () =>
        setIsFullscreen(document.fullscreenElement === containerRef.current);

      document.addEventListener('fullscreenchange', handleFullscreenChange);
      return () =>
        document.removeEventListener(
          'fullscreenchange',
          handleFullscreenChange
        );
    }, [containerRef]);

    const toggleFullscreen = useCallback(() => {
      if (document.fullscreenElement === containerRef.current) {
        document.exitFullscreen().catch(() => {});
      } else {
        containerRef.current?.requestFullscreen().catch(() => {});
      }
    }, [containerRef]);

    const handleDoubleClick = useCallback(() => {
      // Fullscreen is reserved for cards that were ALREADY pinned —
      // an eager double-click on an unpinned card only focuses it.
      if (!isPinned || wasJustFocusedByClick()) return;

      toggleFullscreen();
    }, [isPinned, wasJustFocusedByClick, toggleFullscreen]);

    const handleScreenResolutionChange = useCallback(
      (value: string) => {
        saveDevices({ ...devices, screenResolution: value as Resolution });
      },
      [devices, saveDevices]
    );

    const handleScreenFramerateChange = useCallback(
      (value: string) => {
        saveDevices({ ...devices, screenFramerate: Number(value) });
      },
      [devices, saveDevices]
    );

    // Esc-unpin and auto-unpin bypass handlePinToggle, so reset zoom
    // whenever the card loses its pin, regardless of how.
    useEffect(() => {
      if (!isPinned) resetZoom();
    }, [isPinned, resetZoom]);

    if (!user || !hasScreenShareStream) return null;

    return (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={containerRef}
            className={cn(
              'relative bg-card rounded-lg overflow-hidden group',
              'flex items-center justify-center',
              'w-full h-full',
              'border border-border',
              !isPinned &&
                'cursor-pointer ring-inset hover:ring-2 hover:ring-primary/40 transition-shadow',
              className
            )}
            title={isPinned ? undefined : 'Click to focus'}
            onWheel={handleWheel}
            onMouseDown={handleContainerMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleContainerMouseUp}
            onMouseLeave={handleContainerMouseLeave}
            onDoubleClick={handleDoubleClick}
            style={{
              cursor: isPinned ? getCursor() : undefined
            }}
          >
            <CardGradient />

            <ScreenShareControls
              isPinned={isPinned}
              isZoomEnabled={isZoomEnabled}
              handlePinToggle={handlePinToggle}
              handleToggleZoom={handleToggleZoom}
              showPinControls={showPinControls}
            />

            <video
              ref={screenShareRef}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 w-full h-full object-contain bg-black"
              style={{
                transform: `scale(${zoom}) translate(${position.x / zoom}px, ${position.y / zoom}px)`,
                transition: isDragging ? 'none' : 'transform 0.1s ease-out'
              }}
            />

            <QuickBar>
              {isOwnUser ? (
                <>
                  {hasOutgoingScreenAudio && (
                    <IconButton
                      variant="ghost"
                      icon={screenAudioMuted ? VolumeX : Volume2}
                      onClick={toggleScreenShareAudio}
                      title={
                        screenAudioMuted
                          ? 'Unmute Stream Audio'
                          : 'Mute Stream Audio'
                      }
                      aria-label={
                        screenAudioMuted
                          ? 'Unmute Stream Audio'
                          : 'Mute Stream Audio'
                      }
                      className={cn(
                        QUICK_BTN,
                        screenAudioMuted && 'text-red-400 hover:text-red-300'
                      )}
                      size="xl"
                    />
                  )}
                  <IconButton
                    variant="ghost"
                    icon={MonitorUp}
                    onClick={changeScreenShare}
                    title="Change Source"
                    aria-label="Change Source"
                    className={QUICK_BTN}
                    size="xl"
                  />
                  <IconButton
                    variant="ghost"
                    icon={isFullscreen ? Minimize : Maximize}
                    onClick={toggleFullscreen}
                    title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    className={QUICK_BTN}
                    size="xl"
                  />
                  <IconButton
                    variant="ghost"
                    icon={ScreenShareOff}
                    onClick={toggleScreenShare}
                    title="Stop Streaming"
                    aria-label="Stop Streaming"
                    className={cn(QUICK_BTN, 'text-red-400 hover:text-red-300')}
                    size="xl"
                  />
                </>
              ) : (
                <>
                  {hasScreenShareAudioStream && (
                    <VolumeButton
                      volumeKey={screenVolumeKey}
                      label="Stream Volume"
                      muteLabel="Mute Stream Audio"
                      unmuteLabel="Unmute Stream Audio"
                      size="xl"
                      className={QUICK_BTN}
                    />
                  )}
                  <IconButton
                    variant="ghost"
                    icon={isFullscreen ? Minimize : Maximize}
                    onClick={toggleFullscreen}
                    title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    aria-label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                    className={QUICK_BTN}
                    size="xl"
                  />
                </>
              )}
            </QuickBar>

            <div className="absolute bottom-0 left-0 right-0 p-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity">
              <div className="flex items-center gap-2 min-w-0">
                <Monitor className="size-3.5 text-purple-400 flex-shrink-0" />
                <span className="text-white font-medium text-xs truncate">
                  {user.name}'s screen
                </span>
                {isZoomEnabled && zoom > 1 && (
                  <span className="text-white/70 text-xs ml-auto flex-shrink-0">
                    {Math.round(zoom * 100)}%
                  </span>
                )}
              </div>
            </div>
          </div>
        </ContextMenuTrigger>

        {isOwnUser ? (
          <ContextMenuContent>
            <ContextMenuItem onClick={changeScreenShare}>
              Change Stream
            </ContextMenuItem>
            <ContextMenuSub>
              <ContextMenuSubTrigger>Stream Quality</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuRadioGroup
                  value={devices.screenResolution}
                  onValueChange={handleScreenResolutionChange}
                >
                  {QUALITY_RESOLUTIONS.map((resolution) => (
                    <ContextMenuRadioItem key={resolution} value={resolution}>
                      {resolution}
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
                <ContextMenuSeparator />
                <ContextMenuRadioGroup
                  value={String(devices.screenFramerate)}
                  onValueChange={handleScreenFramerateChange}
                >
                  {QUALITY_FRAMERATES.map((framerate) => (
                    <ContextMenuRadioItem
                      key={framerate}
                      value={String(framerate)}
                    >
                      {framerate} FPS
                    </ContextMenuRadioItem>
                  ))}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
            <ContextMenuItem onClick={toggleFullscreen}>
              {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </ContextMenuItem>
            {hasOutgoingScreenAudio && (
              <ContextMenuCheckboxItem
                checked={screenAudioMuted}
                onCheckedChange={toggleScreenShareAudio}
              >
                Mute Stream Audio
              </ContextMenuCheckboxItem>
            )}
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={toggleScreenShare}>
              Stop Streaming
            </ContextMenuItem>
          </ContextMenuContent>
        ) : (
          <ContextMenuContent>
            <ContextMenuItem onClick={toggleFullscreen}>
              {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </ContextMenuItem>
            {showPinControls && (
              <ContextMenuItem onClick={handlePinToggle}>
                {isPinned ? 'Unpin' : 'Pop Out'}
              </ContextMenuItem>
            )}
            {hasScreenShareAudioStream && (
              <>
                <ContextMenuSeparator />
                <ContextMenuCheckboxItem
                  checked={isScreenAudioMuted}
                  onCheckedChange={() => toggleMute(screenVolumeKey)}
                >
                  Mute Stream Audio
                </ContextMenuCheckboxItem>
                <ContextMenuSub>
                  <ContextMenuSubTrigger>Stream Volume</ContextMenuSubTrigger>
                  <ContextMenuSubContent>
                    <div className="px-3 py-2 w-40">
                      <Slider
                        value={[screenVolume]}
                        min={0}
                        max={100}
                        step={1}
                        onValueChange={([val]) =>
                          setVolume(screenVolumeKey, val)
                        }
                      />
                      <div className="text-xs text-muted-foreground text-center mt-1">
                        {screenVolume}%
                      </div>
                    </div>
                  </ContextMenuSubContent>
                </ContextMenuSub>
              </>
            )}
          </ContextMenuContent>
        )}
      </ContextMenu>
    );
  }
);

ScreenShareCard.displayName = 'ScreenShareCard';

export { ScreenShareCard };
