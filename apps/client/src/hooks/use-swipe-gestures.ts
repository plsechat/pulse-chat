import { useCallback, useRef } from 'react';

type TSwipeHandlers = {
  onSwipeRight?: () => void;
  onSwipeLeft?: () => void;
};

type TSwipeGestureHandlers = {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: () => void;
};

/** Minimum horizontal travel (px) for a swipe. */
const SWIPE_THRESHOLD = 50;
/** A swipe must be clearly horizontal: |dx| > |dy| × this. */
const DIRECTION_RATIO = 1.5;
/** Width (px) of the screen-edge zones that may start a swipe over a
 *  horizontally scrollable target (a code block, the voice filmstrip). */
const EDGE_ZONE = 24;

/**
 * Targets whose own horizontal gesture must win: horizontal scrolling in
 * code blocks, slider thumbs, text selection in inputs and the composer,
 * video scrubbing, and anything opting out with `data-no-swipe`.
 */
const BLOCKED_TARGET_SELECTOR =
  'pre, [role="slider"], input, textarea, select, [contenteditable="true"], video, [data-no-swipe]';

type TSwipeGesture = {
  dx: number;
  dy: number;
  /** The touch started on a target the swipe must not steal. */
  blocked: boolean;
  /** The touch started inside one of the screen-edge zones. */
  fromEdge: boolean;
  /** The touch started inside a horizontally scrollable element. */
  horizontalScroll: boolean;
};

type TSwipeDirection = 'left' | 'right' | null;

/**
 * Pure swipe decision. A gesture becomes a swipe when it travelled far
 * enough, is mostly horizontal, did not start on a blocked target and —
 * when it started inside something that scrolls sideways — started at
 * a screen edge.
 */
const decideSwipe = (gesture: TSwipeGesture): TSwipeDirection => {
  if (gesture.blocked) return null;
  if (Math.abs(gesture.dx) < SWIPE_THRESHOLD) return null;
  if (Math.abs(gesture.dx) <= Math.abs(gesture.dy) * DIRECTION_RATIO) {
    return null;
  }
  if (gesture.horizontalScroll && !gesture.fromEdge) return null;
  return gesture.dx > 0 ? 'right' : 'left';
};

const toElement = (target: EventTarget | null): Element | null => {
  if (target instanceof Element) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
};

/**
 * True when the swipe must leave the touch alone: the target lives in a
 * portal (React synthetic events bubble through portals, so a touch in
 * a popover, a menu or the fullscreen image reaches the view root), or
 * it is one of the blocked controls above.
 */
const isSwipeBlockedTarget = (
  target: EventTarget | null,
  root: HTMLElement
): boolean => {
  const element = toElement(target);
  if (!element) return true;
  if (!root.contains(element)) return true;
  return element.closest(BLOCKED_TARGET_SELECTOR) !== null;
};

/** True when an ancestor between the target and the root scrolls sideways. */
const hasHorizontalScrollAncestor = (
  target: EventTarget | null,
  root: HTMLElement
): boolean => {
  let element = toElement(target);
  while (element && element !== root) {
    if (element.scrollWidth > element.clientWidth + 1) {
      const overflowX = getComputedStyle(element).overflowX;
      if (overflowX === 'auto' || overflowX === 'scroll') return true;
    }
    element = element.parentElement;
  }
  return false;
};

const isInEdgeZone = (x: number, viewportWidth: number): boolean =>
  x <= EDGE_ZONE || x >= viewportWidth - EDGE_ZONE;

type TTouchStart = {
  x: number;
  y: number;
  blocked: boolean;
  fromEdge: boolean;
  horizontalScroll: boolean;
};

/**
 * Horizontal swipe detection for the mobile drawers. Bind the returned
 * handlers on the view root; the hook filters out gestures that belong
 * to something else (see decideSwipe) and multi-touch (pinch).
 */
const useSwipeGestures = (handlers: TSwipeHandlers): TSwipeGestureHandlers => {
  const start = useRef<TTouchStart | null>(null);
  const current = useRef({ x: 0, y: 0 });
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      start.current = null;
      return;
    }
    const touch = e.touches[0];
    const root = e.currentTarget as HTMLElement;
    const blocked = isSwipeBlockedTarget(e.target, root);
    start.current = {
      x: touch.clientX,
      y: touch.clientY,
      blocked,
      fromEdge: isInEdgeZone(touch.clientX, window.innerWidth),
      horizontalScroll: blocked
        ? false
        : hasHorizontalScrollAncestor(e.target, root)
    };
    current.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!start.current) return;
    if (e.touches.length !== 1) {
      // A second finger landed: this is a pinch, never a swipe.
      start.current = null;
      return;
    }
    current.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, []);

  const handleTouchEnd = useCallback(() => {
    const begin = start.current;
    start.current = null;
    if (!begin) return;

    const direction = decideSwipe({
      dx: current.current.x - begin.x,
      dy: current.current.y - begin.y,
      blocked: begin.blocked,
      fromEdge: begin.fromEdge,
      horizontalScroll: begin.horizontalScroll
    });

    if (direction === 'right') handlersRef.current.onSwipeRight?.();
    if (direction === 'left') handlersRef.current.onSwipeLeft?.();
  }, []);

  return {
    onTouchStart: handleTouchStart,
    onTouchMove: handleTouchMove,
    onTouchEnd: handleTouchEnd
  };
};

export {
  decideSwipe,
  hasHorizontalScrollAncestor,
  isSwipeBlockedTarget,
  useSwipeGestures
};
export type { TSwipeGesture };
