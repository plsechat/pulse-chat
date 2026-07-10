import { useEscapeKey } from '@/hooks/use-escape-key';
import { useCallback, useEffect, useRef } from 'react';

const FULLSCREEN_EXIT_GRACE_MS = 500;

/**
 * Unpin the focused card on Escape — but only when the keypress isn't
 * serving native fullscreen.
 *
 * While a fullscreen element exists, Esc belongs to the browser's own
 * exit mechanism. Browsers may deliver the Escape keydown before OR
 * after `fullscreenchange`, so two guards are needed: a live
 * `document.fullscreenElement` check (keydown-first ordering) and a
 * short grace window after a fullscreen exit (fullscreenchange-first
 * ordering). Otherwise the same keystroke that exits fullscreen would
 * also unpin the card.
 */
const useUnpinOnEscape = (enabled: boolean, unpin: () => void) => {
  const lastFullscreenExitAtRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;

    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        lastFullscreenExitAtRef.current = Date.now();
      }
    };

    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
    };
  }, [enabled]);

  const handleEscape = useCallback(() => {
    if (document.fullscreenElement) return;
    if (Date.now() - lastFullscreenExitAtRef.current < FULLSCREEN_EXIT_GRACE_MS)
      return;

    unpin();
  }, [unpin]);

  useEscapeKey(handleEscape, enabled);
};

export { useUnpinOnEscape };
