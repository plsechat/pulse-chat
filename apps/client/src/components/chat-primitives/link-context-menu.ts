/**
 * Right-clicking a link inside a message.
 *
 * The browser's own menu for a link (Copy Link Address, Open in New
 * Tab) is the one people reach for, and the message menu hid it: the
 * radix trigger opens on the bubble-phase contextmenu event and
 * prevents the default, and the document-level suppressor prevents
 * whatever reaches it. A capture-phase handler on the trigger sees the
 * event first and, when it landed on a link, stops it right there —
 * nothing below runs, nothing is prevented, the native menu shows.
 *
 * Where there is no native menu the message menu opens as usual and
 * carries a "Copy Link" item for the link that was hit: the desktop
 * shell draws no menu of its own on right-click, and a touch long-press
 * opens ours through radix's own timer without a contextmenu event.
 *
 * The keyboard path is untouched: the context-menu key on a focused
 * message row targets the row, not a link, and opens the menu as before.
 */
import { useCallback, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { toast } from 'sonner';

/**
 * The absolute href of the link `target` sits in, or null when the hit
 * was not on a link. Bounded to `root` so a link outside the trigger
 * (an ancestor the row happens to sit in) never counts.
 */
const linkHrefFromTarget = (
  target: EventTarget | null,
  root: Element | null
): string | null => {
  if (!(target instanceof Element)) return null;
  const anchor = target.closest('a[href]');
  if (!anchor || (root && !root.contains(anchor))) return null;
  const href = (anchor as HTMLAnchorElement).href;
  return href ? href : null;
};

/**
 * Whether the host draws a context menu of its own on right-click. The
 * desktop shell draws none, so letting the event through there would
 * show nothing at all.
 */
const hasNativeContextMenu = (): boolean =>
  typeof window === 'undefined' || !window.pulseDesktop;

const useLinkContextMenu = () => {
  const [linkHref, setLinkHref] = useState<string | null>(null);

  // Touch/pen: radix opens on its own long-press timer from pointerdown
  // and no contextmenu event follows, so remember what was under the
  // finger here.
  const onPointerDownCapture = useCallback((e: PointerEvent<HTMLElement>) => {
    setLinkHref(linkHrefFromTarget(e.target, e.currentTarget));
  }, []);

  const onContextMenuCapture = useCallback((e: MouseEvent<HTMLElement>) => {
    const href = linkHrefFromTarget(e.target, e.currentTarget);
    setLinkHref(href);
    if (href && hasNativeContextMenu()) {
      // Stops the native event at the React root during capture, so the
      // trigger's bubble handler and the document suppressor never see
      // it; the default action (the browser's link menu) still runs.
      e.stopPropagation();
    }
  }, []);

  const copyLink = useCallback(() => {
    if (!linkHref) return;
    navigator.clipboard.writeText(linkHref);
    toast.success('Link copied');
  }, [linkHref]);

  return {
    /** The link the menu was opened on, if any. */
    linkHref,
    copyLink,
    /** Spread onto the ContextMenuTrigger. */
    triggerProps: { onPointerDownCapture, onContextMenuCapture }
  };
};

export { hasNativeContextMenu, linkHrefFromTarget, useLinkContextMenu };
