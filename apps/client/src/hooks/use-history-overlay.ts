import { pushOverlay, releaseOverlay } from '@/lib/overlay-history';
import { useEffect, useRef } from 'react';

/**
 * Ties an overlay's open state to a browser-history entry so the
 * platform back gesture closes it (lib/overlay-history). Pass `open`
 * only while the surface really is an overlay — a sidebar that is part
 * of the desktop layout must not push history, so callers gate on the
 * breakpoint: `useHistoryOverlay(isOpen && isMobile, close)`.
 */
const useHistoryOverlay = (open: boolean, close: () => void) => {
  const closeRef = useRef(close);
  closeRef.current = close;
  const idRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      if (idRef.current === null) {
        idRef.current = pushOverlay(() => {
          // Popped by Back: the entry is gone already, only close the UI.
          idRef.current = null;
          closeRef.current();
        });
      }
      return;
    }
    if (idRef.current !== null) {
      releaseOverlay(idRef.current);
      idRef.current = null;
    }
  }, [open]);

  // Unmounting while open (view switch) is a close too.
  useEffect(
    () => () => {
      if (idRef.current !== null) {
        releaseOverlay(idRef.current);
        idRef.current = null;
      }
    },
    []
  );
};

export { useHistoryOverlay };
