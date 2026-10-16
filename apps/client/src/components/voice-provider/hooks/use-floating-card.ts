import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useEffect, useRef, useState } from 'react';

type TPosition = {
  x: number;
  y: number;
};

/** Keep `position` inside `parent` for a card of `card`'s size. */
const clampToParent = (
  position: TPosition,
  parent: DOMRect,
  card: DOMRect
): TPosition => ({
  x: Math.max(0, Math.min(position.x, parent.width - card.width)),
  y: Math.max(0, Math.min(position.y, parent.height - card.height))
});

/**
 * Drag + persisted position for the floating pinned card. Pointer
 * events (mouse, pen and touch alike; the card is `touch-none` so the
 * browser does not scroll instead). The saved position is clamped to
 * the current viewport on mount and on resize — a position saved on a
 * wide desktop window used to put the whole card off-screen on a
 * narrower one, with no way to reach its controls.
 */
export const useFloatingCard = () => {
  const cardRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<TPosition | undefined>(
    getLocalStorageItemAsJSON<TPosition>(LocalStorageKey.FLOATING_CARD_POSITION)
  );
  const dragRef = useRef<{ pointerId: number; offset: TPosition } | null>(
    null
  );

  useEffect(() => {
    if (position) {
      setLocalStorageItemAsJSON<TPosition>(
        LocalStorageKey.FLOATING_CARD_POSITION,
        position
      );
    }
  }, [position]);

  const clampCurrent = useCallback(() => {
    const card = cardRef.current;
    const parent = card?.parentElement;
    if (!card || !parent) return;
    setPosition((current) => {
      if (!current) return current;
      const next = clampToParent(
        current,
        parent.getBoundingClientRect(),
        card.getBoundingClientRect()
      );
      return next.x === current.x && next.y === current.y ? current : next;
    });
  }, []);

  // Clamp on mount (the card may be mounted with a stale saved spot)
  // and whenever the window changes size.
  useEffect(() => {
    clampCurrent();
    window.addEventListener('resize', clampCurrent);
    return () => window.removeEventListener('resize', clampCurrent);
  }, [clampCurrent]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (!cardRef.current || e.button !== 0) return;
    const rect = cardRef.current.getBoundingClientRect();
    dragRef.current = {
      pointerId: e.pointerId,
      offset: { x: e.clientX - rect.left, y: e.clientY - rect.top }
    };
    cardRef.current.setPointerCapture?.(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    const card = cardRef.current;
    const parent = card?.parentElement;
    if (!drag || drag.pointerId !== e.pointerId || !card || !parent) return;

    const parentRect = parent.getBoundingClientRect();
    setPosition(
      clampToParent(
        {
          x: e.clientX - parentRect.left - drag.offset.x,
          y: e.clientY - parentRect.top - drag.offset.y
        },
        parentRect,
        card.getBoundingClientRect()
      )
    );
  }, []);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    cardRef.current?.releasePointerCapture?.(e.pointerId);
  }, []);

  const getStyle = useCallback(() => {
    return {
      right: position ? undefined : '1rem',
      bottom: position ? undefined : '1rem',
      left: position ? `${position.x}px` : undefined,
      top: position ? `${position.y}px` : undefined
    };
  }, [position]);

  const resetCard = useCallback(() => {
    setPosition(undefined);
  }, []);

  return {
    cardRef,
    dragHandlers: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp
    },
    getStyle,
    resetCard
  };
};

