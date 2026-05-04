import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useEffect, useRef, useState } from 'react';

type TScrollPositionEntry = {
  scrollTop: number;
  atBottom: boolean;
};
type TScrollPositionMap = Record<number, TScrollPositionEntry>;

// In-memory cache (fast reads), backed by localStorage (survives refresh)
const scrollPositions: TScrollPositionMap = loadScrollPositions();

function loadScrollPositions(): TScrollPositionMap {
  const raw = getLocalStorageItemAsJSON<
    Record<number, number | TScrollPositionEntry>
  >(LocalStorageKey.SCROLL_POSITIONS);
  if (!raw) return {};
  // Migrate legacy number-only shape to {scrollTop, atBottom}
  const out: TScrollPositionMap = {};
  for (const [k, v] of Object.entries(raw)) {
    out[Number(k)] =
      typeof v === 'number' ? { scrollTop: v, atBottom: false } : v;
  }
  return out;
}

function persistScrollPositions() {
  setLocalStorageItemAsJSON(LocalStorageKey.SCROLL_POSITIONS, scrollPositions);
}

// Throttle localStorage writes to avoid thrashing on every scroll event
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistScrollPositions();
  }, 300);
}

type TUseScrollControllerProps = {
  channelId: number;
  messages: unknown[];
  fetching: boolean;
  hasMore: boolean;
  loadMore: () => Promise<unknown>;
};

type TUseScrollControllerReturn = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  scrollToBottom: () => void;
  isAtBottom: boolean;
};

const useScrollController = ({
  channelId,
  messages,
  fetching,
  hasMore,
  loadMore
}: TUseScrollControllerProps): TUseScrollControllerReturn => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitialScroll = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const checkIsAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    const scrollPosition = container.scrollTop + container.clientHeight;
    const threshold = container.scrollHeight * 0.9;
    return scrollPosition >= threshold;
  }, []);

  // scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    scrollPositions[channelId] = {
      scrollTop: container.scrollTop,
      atBottom: true
    };
    schedulePersist();
    setIsAtBottom(true);
  }, [channelId]);

  // detect scroll-to-top and load more messages
  const onScroll = useCallback(() => {
    const container = containerRef.current;

    if (!container || fetching) return;

    // Save scroll position + whether the user is anchored at the bottom.
    // atBottom is the load-bearing flag: scrollTop is in absolute pixels and
    // becomes meaningless once scrollHeight grows (more messages loaded), but
    // atBottom stays correct because it's a relative concept.
    const atBottom = checkIsAtBottom();
    scrollPositions[channelId] = {
      scrollTop: container.scrollTop,
      atBottom
    };
    schedulePersist();

    setIsAtBottom(atBottom);

    if (container.scrollTop <= 50 && hasMore) {
      const prevScrollHeight = container.scrollHeight;

      loadMore().then(() => {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop =
          newScrollHeight - prevScrollHeight + container.scrollTop;
      });
    }
  }, [loadMore, hasMore, fetching, channelId, checkIsAtBottom]);

  // Reset the "did we restore yet?" flag when the channel changes.
  // Without this, switching A→B→A keeps the flag true from the A visit and
  // the restore branch below is skipped, leaving the user wherever the
  // browser placed scrollTop (typically 0 = top).
  useEffect(() => {
    hasInitialScroll.current = false;
  }, [channelId]);

  // Save scroll position on unmount
  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (container) {
        const atBottom =
          container.scrollTop + container.clientHeight >=
          container.scrollHeight * 0.9;
        scrollPositions[channelId] = {
          scrollTop: container.scrollTop,
          atBottom
        };
        // Flush immediately on unmount so it's saved before page unload
        persistScrollPositions();
      }
    };
  }, [channelId]);

  // Handle initial scroll after messages load
  useEffect(() => {
    if (!containerRef.current) return;
    if (fetching || messages.length === 0) return;

    if (!hasInitialScroll.current) {
      const saved = scrollPositions[channelId];

      const performScroll = () => {
        const container = containerRef.current;
        if (!container) return;

        // Always honor the bottom anchor over a stale scrollTop value —
        // scrollHeight may have changed since save time (more/fewer messages
        // loaded), so a saved scrollTop near the old bottom would land in
        // the middle of the new content. atBottom stays correct regardless.
        if (saved?.atBottom || saved === undefined) {
          scrollToBottom();
        } else {
          container.scrollTop = saved.scrollTop;
          setIsAtBottom(checkIsAtBottom());
        }
        hasInitialScroll.current = true;
      };

      // 1: immediate attempt
      performScroll();

      // 2: wait for next frame
      requestAnimationFrame(() => {
        performScroll();
      });

      // 3: short timeout for any async content
      setTimeout(() => {
        performScroll();
      }, 50);

      // 4: longer timeout for images and other media
      setTimeout(() => {
        performScroll();
      }, 200);
    }
  }, [fetching, messages.length, scrollToBottom, channelId, checkIsAtBottom]);

  // auto-scroll on new messages if user is near bottom
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasInitialScroll.current || messages.length === 0)
      return;

    if (checkIsAtBottom()) {
      // scroll after a short delay to allow content to render
      setTimeout(() => {
        scrollToBottom();
      }, 10);
    }
  }, [messages, scrollToBottom, checkIsAtBottom]);

  return {
    containerRef,
    onScroll,
    scrollToBottom,
    isAtBottom
  };
};

export { useScrollController };
