import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Portal target for Radix overlays. While an element is fullscreened
 * (screen-share cards via requestFullscreen), the browser only paints
 * that element's subtree — portals mounted on document.body become
 * invisible. Portaling into the fullscreen element keeps context menus,
 * popovers, and dialogs usable; undefined falls back to Radix's
 * document.body default. Evaluated on open (content mounts lazily), so
 * it tracks fullscreen transitions without a listener.
 */
export function portalContainer(): HTMLElement | undefined {
  return (document.fullscreenElement as HTMLElement | null) ?? undefined;
}
