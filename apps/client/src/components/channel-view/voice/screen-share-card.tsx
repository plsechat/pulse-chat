import { IconButton } from '@/components/ui/icon-button';
import { useUserById } from '@/features/server/users/hooks';
import { cn } from '@/lib/utils';
import { Monitor, ZoomIn, ZoomOut } from 'lucide-react';
import { memo, useCallback, useEffect } from 'react';
import { CardControls } from './card-controls';
import { CardGradient } from './card-gradient';
import { useCardClickFocus } from './hooks/use-card-click-focus';
import { useScreenShareZoom } from './hooks/use-screen-share-zoom';
import { useVoiceRefs } from './hooks/use-voice-refs';
import { PinButton } from './pin-button';

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
    const { screenShareRef, hasScreenShareStream } = useVoiceRefs(userId);

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

    const handleDoubleClick = useCallback(() => {
      // Fullscreen is reserved for cards that were ALREADY pinned —
      // an eager double-click on an unpinned card only focuses it.
      if (!isPinned || wasJustFocusedByClick()) return;

      if (document.fullscreenElement === containerRef.current) {
        document.exitFullscreen().catch(() => {});
      } else {
        containerRef.current?.requestFullscreen().catch(() => {});
      }
    }, [isPinned, wasJustFocusedByClick, containerRef]);

    // Esc-unpin and auto-unpin bypass handlePinToggle, so reset zoom
    // whenever the card loses its pin, regardless of how.
    useEffect(() => {
      if (!isPinned) resetZoom();
    }, [isPinned, resetZoom]);

    if (!user || !hasScreenShareStream) return null;

    return (
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
    );
  }
);

ScreenShareCard.displayName = 'ScreenShareCard';

export { ScreenShareCard };
