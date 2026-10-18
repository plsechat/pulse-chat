import { isCoarsePointer } from '@/hooks/use-is-mobile';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * Which message row has its per-row controls open on a touch screen.
 *
 * Hover reveals the action toolbar, the gutter timestamp and the
 * add-reaction pill on a mouse. A phone has no hover, and showing them
 * on every row at once (the previous `group-hover-or-touch`) laid a
 * toolbar over the text of every message. Instead a tap on a row makes
 * it the ONE active row (`data-actions-open`, read by the
 * `group-hover-or-active` variant in index.css); a tap on another row
 * moves it, a tap on the same row or anywhere else clears it, and so
 * does scrolling by finger or wheel. Channels and DMs share the store,
 * keyed by the row's DOM id (`msg-<id>` / `dm-msg-<id>`).
 *
 * Pure module state read through useSyncExternalStore with a per-key
 * selector, so only the two rows whose state changes re-render.
 */

type TListener = () => void;

let activeKey: string | null = null;
const listeners = new Set<TListener>();

/** Layers a tap can land in without meaning "somewhere else": the
 *  emoji picker and context menu the toolbar opens, confirm dialogs,
 *  toasts. Clearing on those tore the picker down mid-pick. */
const OVERLAY_SELECTOR =
  '[data-radix-popper-content-wrapper], [role="dialog"], [role="alertdialog"], [role="menu"], em-emoji-picker, [data-sonner-toaster]';

/** Targets whose own tap must not double as a row toggle. */
const INTERACTIVE_SELECTOR =
  'a, button, input, textarea, select, label, summary, video, audio, [role="button"], [role="link"], [contenteditable="true"]';

/** Finger travel below this is a tap, not a scroll. */
const SCROLL_SLOP_PX = 10;

const pickerOpen = () => !!document.querySelector('em-emoji-picker');

const emit = () => listeners.forEach((listener) => listener());

const closest = (target: EventTarget | null, selector: string) =>
  target instanceof Element ? target.closest(selector) : null;

const onPointerDown = (e: PointerEvent) => {
  if (activeKey === null) return;
  if (closest(e.target, OVERLAY_SELECTOR)) return;
  const row = document.getElementById(activeKey);
  if (row && e.target instanceof Node && row.contains(e.target)) return;
  setActiveMessage(null);
};

let touchOrigin: { x: number; y: number } | null = null;

const onTouchStart = (e: TouchEvent) => {
  const touch = e.touches[0];
  touchOrigin = touch ? { x: touch.clientX, y: touch.clientY } : null;
};

// A finger that travels is a scroll. The container's `scroll` event is
// not used on purpose: the toolbar appearing in flow grows the list,
// and the chat's bottom re-pin then scrolls programmatically — that
// must not close what was just opened.
const onTouchMove = (e: TouchEvent) => {
  if (activeKey === null || !touchOrigin) return;
  const touch = e.touches[0];
  if (!touch) return;
  const dx = touch.clientX - touchOrigin.x;
  const dy = touch.clientY - touchOrigin.y;
  if (Math.hypot(dx, dy) < SCROLL_SLOP_PX) return;
  if (pickerOpen() || closest(e.target, OVERLAY_SELECTOR)) return;
  setActiveMessage(null);
};

const onWheel = (e: WheelEvent) => {
  if (activeKey === null) return;
  if (pickerOpen() || closest(e.target, OVERLAY_SELECTOR)) return;
  setActiveMessage(null);
};

const attach = () => {
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
  document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  document.addEventListener('wheel', onWheel, { capture: true, passive: true });
};

const detach = () => {
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('touchstart', onTouchStart, true);
  document.removeEventListener('touchmove', onTouchMove, true);
  document.removeEventListener('wheel', onWheel, true);
  touchOrigin = null;
};

const setActiveMessage = (key: string | null) => {
  if (key === activeKey) return;
  const hadActive = activeKey !== null;
  activeKey = key;
  if (!hadActive && key !== null) attach();
  if (key === null) detach();
  emit();
};

const toggleActiveMessage = (key: string) =>
  setActiveMessage(activeKey === key ? null : key);

const getActiveMessageKey = () => activeKey;

const subscribe = (listener: TListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Row click handler for the toggle. Only a coarse pointer toggles (a
 * mouse has hover); taps on links, buttons, inputs and a text selection
 * (the long-press that opens the context menu) pass through. Returns
 * whether the tap was consumed.
 */
const handleRowTap = (e: React.MouseEvent, key: string): boolean => {
  if (!isCoarsePointer()) return false;
  if (closest(e.target, INTERACTIVE_SELECTOR)) return false;
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().length > 0) {
    return false;
  }
  toggleActiveMessage(key);
  return true;
};

/** Whether this row is the active one (per-key selector). */
const useIsActiveMessage = (key: string): boolean =>
  useSyncExternalStore(
    subscribe,
    () => activeKey === key,
    () => false
  );

/**
 * useIsActiveMessage plus the row's lifecycle: a row that unmounts
 * while active (channel switch, message window trim) releases it, so
 * the listeners do not stay attached to a row that is gone.
 */
const useActiveMessageRow = (key: string): boolean => {
  const active = useIsActiveMessage(key);
  useEffect(
    () => () => {
      if (activeKey === key) setActiveMessage(null);
    },
    [key]
  );
  return active;
};

export {
  getActiveMessageKey,
  handleRowTap,
  setActiveMessage,
  toggleActiveMessage,
  useActiveMessageRow,
  useIsActiveMessage
};
