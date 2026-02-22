import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useEffect, useRef, useState } from 'react';

type TScrollPositionMap = Record<number, number>;

// In-memory cache (fast reads), backed by localStorage (survives refresh)
const scrollPositions: TScrollPositionMap = loadScrollPositions();

function loadScrollPositions(): TScrollPositionMap {
  return (
    getLocalStorageItemAsJSON<TScrollPositionMap>(
      LocalStorageKey.SCROLL_POSITIONS
    ) ?? {}
  );
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
    delete scrollPositions[channelId];
    schedulePersist();
    setIsAtBottom(true);
  }, [channelId]);

  // detect scroll-to-top and load more messages
  const onScroll = useCallback(() => {
    const container = containerRef.current;

    if (!container || fetching) return;

    // Save scroll position
    scrollPositions[channelId] = container.scrollTop;
    schedulePersist();

    // Update isAtBottom state
    setIsAtBottom(checkIsAtBottom());

    if (container.scrollTop <= 50 && hasMore) {
      const prevScrollHeight = container.scrollHeight;

      loadMore().then(() => {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop =
          newScrollHeight - prevScrollHeight + container.scrollTop;
      });
    }
  }, [loadMore, hasMore, fetching, channelId, checkIsAtBottom]);

  // Save scroll position on unmount
  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (container) {
        scrollPositions[channelId] = container.scrollTop;
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
      const savedPosition = scrollPositions[channelId];

      const performScroll = () => {
        const container = containerRef.current;
        if (!container) return;

        if (savedPosition !== undefined) {
          container.scrollTop = savedPosition;
          setIsAtBottom(checkIsAtBottom());
        } else {
          scrollToBottom();
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
