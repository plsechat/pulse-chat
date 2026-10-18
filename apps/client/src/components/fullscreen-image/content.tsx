import { useEscapeKey } from '@/hooks/use-escape-key';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/button';

const portalRoot = document.getElementById('imagePortal')!;

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
const INITIAL_SCALE = 1;

type TFullScreenImageProps = React.ImgHTMLAttributes<HTMLImageElement>;

type TPoint = { x: number; y: number };

const distance = (a: TPoint, b: TPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const clampScale = (scale: number) =>
  Math.min(Math.max(scale, MIN_SCALE), MAX_SCALE);

/**
 * Full-screen image viewer. Pointer events drive both the mouse and
 * touch: one pointer pans, two pointers pinch-zoom (the image is
 * `touch-none`, so the browser does not page-zoom instead). The wheel
 * zooms with a mouse. Opens and resets at the same scale, so a reopen
 * looks like the first open.
 */
const FullScreenImage = memo((props: TFullScreenImageProps) => {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [scale, setScale] = useState(INITIAL_SCALE);
  const [position, setPosition] = useState<TPoint>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);

  /** Active pointers by id (one = pan, two = pinch). */
  const pointers = useRef(new Map<number, TPoint>());
  const pinchDistance = useRef<number | null>(null);
  const movedRef = useRef(false);

  const onOpenClick = useCallback(() => {
    setOpen(true);
    setTimeout(() => setVisible(true), 10);
  }, []);

  const onCloseClick = useCallback(() => {
    setVisible(false);
    setTimeout(() => setOpen(false), 300);
    setScale(INITIAL_SCALE);
    setPosition({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    setScale((prev) => clampScale(prev - e.deltaY * 0.001));
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedRef.current = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinchDistance.current = distance(a, b);
    }
    setIsDragging(true);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const previous = pointers.current.get(e.pointerId);
    if (!previous) return;
    const next = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, next);

    if (pointers.current.size >= 2) {
      // Pinch: scale by the change in finger distance.
      const [a, b] = [...pointers.current.values()];
      const current = distance(a, b);
      if (pinchDistance.current && current > 0) {
        const factor = current / pinchDistance.current;
        setScale((prev) => clampScale(prev * factor));
      }
      pinchDistance.current = current;
      movedRef.current = true;
      return;
    }

    const deltaX = next.x - previous.x;
    const deltaY = next.y - previous.y;
    if (deltaX !== 0 || deltaY !== 0) movedRef.current = true;
    setPosition((prev) => ({ x: prev.x + deltaX, y: prev.y + deltaY }));
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (pointers.current.size < 2) pinchDistance.current = null;
    if (pointers.current.size === 0) setIsDragging(false);
  }, []);

  const onClickOutside = useCallback(() => {
    if (!isDragging) onCloseClick();
  }, [isDragging, onCloseClick]);

  useEscapeKey(onCloseClick, open);

  useEffect(() => {
    if (!open) return;

    const activePointers = pointers.current;
    document.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      document.removeEventListener('wheel', handleWheel);
      activePointers.clear();
      pinchDistance.current = null;
    };
  }, [open, handleWheel]);

  const portalContainer = createPortal(
    <>
      <div
        className={cn(
          'fixed inset-0 flex justify-center items-center backdrop-blur-sm bg-black/30 z-50 transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0',
          open ? 'pointer-events-auto' : 'pointer-events-none'
        )}
        onClick={onClickOutside}
      >
        {/* The gesture surface is the wrapper, not the <img> (an image
            is not an interactive element); it is sized by the image. */}
        <div
          className="flex max-w-full max-h-full items-center justify-center touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onClick={(e) => e.stopPropagation()}
        >
          <img
            {...props}
            style={{
              transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
              cursor: isDragging ? 'grabbing' : 'grab'
            }}
            className={cn(
              'p-4 max-w-full max-h-full object-contain select-none',
              !isDragging && 'transition-transform duration-100'
            )}
            draggable={false}
          />
        </div>
        <Button
          onClick={onCloseClick}
          size="icon"
          variant="outline"
          className="absolute top-2 right-2 z-50"
          title="Close"
        >
          <X size="1.1rem" />
        </Button>
      </div>
    </>,
    portalRoot
  );

  return (
    <>
      <img
        {...props}
        className={cn('cursor-pointer', props.className)}
        role="button"
        tabIndex={0}
        onClick={onOpenClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenClick();
          }
        }}
        draggable={false}
      />
      {portalContainer}
    </>
  );
});

export { FullScreenImage };
