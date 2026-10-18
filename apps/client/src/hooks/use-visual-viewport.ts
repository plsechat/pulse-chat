import { useEffect, useState } from 'react';
import { isCoarsePointer } from './use-is-mobile';

/**
 * Below this many pixels of lost height the change is browser chrome
 * (URL bar collapse), not a keyboard.
 */
const KEYBOARD_MIN_HEIGHT = 120;

/**
 * The tallest visual viewport seen at the current width. A keyboard is
 * "this much shorter than that". Measured against the viewport itself
 * rather than window.innerHeight because Chrome with
 * `interactive-widget=resizes-content` shrinks BOTH for the keyboard,
 * which would make the two always agree. A width change (rotation)
 * starts a new baseline.
 */
type TBaseline = { width: number; maxHeight: number };

const nextBaseline = (
  previous: TBaseline | null,
  vv: VisualViewport
): TBaseline =>
  !previous || previous.width !== vv.width
    ? { width: vv.width, maxHeight: vv.height }
    : { width: vv.width, maxHeight: Math.max(previous.maxHeight, vv.height) };

const keyboardShowing = (baseline: TBaseline, vv: VisualViewport): boolean =>
  // Pinch zoom also shrinks the visual viewport — that is not a keyboard.
  vv.scale <= 1.01 && baseline.maxHeight - vv.height >= KEYBOARD_MIN_HEIGHT;

/**
 * Keeps `--vvh` on <html> at the visual viewport height (index.css
 * declares it as 100dvh over the appearance zoom). iOS Safari and Chrome without
 * `interactive-widget=resizes-content` keep the layout viewport when the
 * soft keyboard opens and shrink only the visual viewport — a `dvh`
 * shell then stays tall, the browser pans it, and the header scrolls
 * off while typing. Sizing the shell with `h-(--vvh)` keeps it inside
 * the visible area instead.
 */
const useVisualViewportHeight = () => {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;

    const apply = () => {
      if (vv.scale > 1.01) return; // pinch zoom: leave the layout alone
      // Divided by the appearance zoom: inside the zoomed root a px is
      // `zoom` real pixels, while visualViewport reports real ones.
      root.style.setProperty(
        '--vvh',
        `calc(${Math.round(vv.height)}px / var(--app-zoom, 1))`
      );
    };

    apply();
    vv.addEventListener('resize', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      root.style.removeProperty('--vvh');
    };
  }, []);
};

/**
 * True while the visual viewport is a keyboard's worth shorter than the
 * tallest it has been at this width. Touch devices only — a desktop
 * window being resized is not a keyboard. False where visualViewport
 * is missing.
 */
const useVisualViewportKeyboard = (): boolean => {
  const [showing, setShowing] = useState(false);

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !isCoarsePointer()) return;
    let baseline: TBaseline | null = null;
    const update = () => {
      baseline = nextBaseline(baseline, vv);
      setShowing(keyboardShowing(baseline, vv));
    };
    update();
    vv.addEventListener('resize', update);
    return () => vv.removeEventListener('resize', update);
  }, []);

  return showing;
};

export { useVisualViewportHeight, useVisualViewportKeyboard };
