import { useCallback, useRef } from 'react';

const CLICK_DRAG_THRESHOLD_PX = 5;
const DOUBLE_CLICK_WINDOW_MS = 500;

/**
 * Click-to-focus for screen-like cards whose container also hosts
 * drag-pan zoom mouse handlers.
 *
 * A mouseup counts as a focus click only when the card is unpinned
 * (while pinned the mouse belongs to zoom-pan) AND the pointer
 * travelled less than 5px since mousedown (a drag is never a click).
 * Clicks landing on the overlay control buttons are ignored so they
 * keep their own behavior.
 */
const useCardClickFocus = (isPinned: boolean, onFocus: () => void) => {
  const pressStartRef = useRef<{ x: number; y: number } | null>(null);
  const focusedByClickAtRef = useRef(0);

  const handleClickMouseDown = useCallback(
    (e: React.MouseEvent) => {
      pressStartRef.current =
        !isPinned && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
    },
    [isPinned]
  );

  const handleClickMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const pressStart = pressStartRef.current;
      pressStartRef.current = null;

      if (isPinned || !pressStart) return;

      const travelled = Math.hypot(
        e.clientX - pressStart.x,
        e.clientY - pressStart.y
      );
      if (travelled >= CLICK_DRAG_THRESHOLD_PX) return;

      if (e.target instanceof Element && e.target.closest('button')) return;

      focusedByClickAtRef.current = Date.now();
      onFocus();
    },
    [isPinned, onFocus]
  );

  const cancelClick = useCallback(() => {
    pressStartRef.current = null;
  }, []);

  /**
   * True when the focus click happened within the double-click window.
   * Keeps an eager double-click on an UNPINNED card from also
   * triggering fullscreen right after its first click pinned the card.
   */
  const wasJustFocusedByClick = useCallback(
    () => Date.now() - focusedByClickAtRef.current < DOUBLE_CLICK_WINDOW_MS,
    []
  );

  return {
    handleClickMouseDown,
    handleClickMouseUp,
    cancelClick,
    wasJustFocusedByClick
  };
};

export { useCardClickFocus };
