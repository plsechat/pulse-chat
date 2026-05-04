import { useEffect, type RefObject } from 'react';

/**
 * Closes a hand-rolled popover (pinned messages, search, thread list,
 * etc.) when the user clicks outside its bounds. Listens at the
 * document level on `mousedown` so the dismiss happens before any
 * subsequent click handler fires; using `mousedown` instead of `click`
 * also stops the popover from briefly receiving the click that opened
 * it (the trigger button's click event runs first, sets the visible
 * state to true, then this listener registers — by the time the user
 * clicks anywhere else, the listener is live).
 *
 * The `ignoreRefs` parameter is for the trigger button so its own
 * click doesn't immediately dismiss what it just opened. Pass any
 * additional refs that should NOT count as outside (e.g. portaled
 * children that render outside the popover's DOM tree).
 *
 * Radix-backed popovers handle this internally — only use this for
 * the popovers that are plain absolute-positioned <div>s.
 */
export const useDismissOnOutsideClick = (
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  ignoreRefs?: RefObject<HTMLElement | null>[]
) => {
  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (containerRef.current?.contains(target)) return;
      if (ignoreRefs?.some((r) => r.current?.contains(target))) return;
      onDismiss();
    };
    // Capture phase so we can react before any popover-internal
    // mousedown handlers run (rare, but keeps semantics clean).
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [open, containerRef, onDismiss, ignoreRefs]);
};
