import { useEffect } from 'react';

/**
 * Mount a `keydown` listener on `document` that calls `handler`
 * exactly when Escape is pressed and the hook is enabled.
 *
 * Replaces three near-identical inline copies (server-screens,
 * mod-view-sheet, fullscreen-image). Each had its own
 * `addEventListener('keydown', …)` + `removeEventListener` boilerplate
 * with subtly different `enabled` gating. Using a real hook makes
 * disable/enable trivial: pass `false` for `enabled` and the
 * listener is unbound.
 */
const useEscapeKey = (handler: () => void, enabled = true) => {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        handler();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, handler]);
};

export { useEscapeKey };
