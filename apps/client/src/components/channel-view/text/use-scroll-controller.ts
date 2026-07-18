import { useConnectedServerPublicId } from '@/features/server/hooks';
import { peekPendingJump } from '@/features/server/messages/jump';
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
// Keyed by `${serverPublicId}:${channelId}` — bare numeric channel ids
// collide across federated instances (same reason content-wrapper keys
// the view on the connected server's publicId).
type TScrollPositionMap = Record<string, TScrollPositionEntry>;

// In-memory cache (fast reads), backed by localStorage (survives refresh)
const scrollPositions: TScrollPositionMap = loadScrollPositions();

function loadScrollPositions(): TScrollPositionMap {
  const raw = getLocalStorageItemAsJSON<
    Record<string, number | TScrollPositionEntry>
  >(LocalStorageKey.SCROLL_POSITIONS);
  if (!raw) return {};
  const out: TScrollPositionMap = {};
  for (const [k, v] of Object.entries(raw)) {
    // Drop legacy entries: bare-number values and unscoped numeric keys
    // predate the {scrollTop, atBottom} shape / publicId scoping and
    // would restore wrong positions.
    if (typeof v === 'number' || !k.includes(':')) continue;
    out[k] = v;
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

/**
 * "At bottom" as an absolute pixel distance. The previous check used
 * `scrollHeight * 0.9`, which scales with content: with a long history
 * loaded, positions several screens above the end still counted as
 * "at bottom" — saved positions restored to the wrong place and the
 * auto-follow yanked the view down while reading. 100px is roughly the
 * height of the last message group.
 */
const AT_BOTTOM_PX = 100;
function isNearBottom(container: HTMLElement): boolean {
  return (
    container.scrollHeight - (container.scrollTop + container.clientHeight) <
    AT_BOTTOM_PX
  );
}

type TUseScrollControllerProps = {
  channelId: number;
  messages: unknown[];
  fetching: boolean;
  hasMore: boolean;
  loadMore: () => Promise<unknown>;
  /** Detached-window mode (after a jump): page forward near the bottom. */
  detached?: boolean;
  loadNewer?: () => Promise<unknown>;
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
  loadMore,
  detached = false,
  loadNewer
}: TUseScrollControllerProps): TUseScrollControllerReturn => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitialScroll = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const serverPublicId = useConnectedServerPublicId();
  const posKey = `${serverPublicId ?? 'connecting'}:${channelId}`;

  const checkIsAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    return isNearBottom(container);
  }, []);

  // scroll to bottom function
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    scrollPositions[posKey] = {
      scrollTop: container.scrollTop,
      atBottom: true
    };
    schedulePersist();
    setIsAtBottom(true);
  }, [posKey]);

  // detect scroll-to-top and load more messages
  const onScroll = useCallback(() => {
    const container = containerRef.current;

    if (!container || fetching) return;

    // Save scroll position + whether the user is anchored at the bottom.
    // atBottom is the load-bearing flag: scrollTop is in absolute pixels and
    // becomes meaningless once scrollHeight grows (more messages loaded), but
    // atBottom stays correct because it's a relative concept.
    const atBottom = checkIsAtBottom();
    scrollPositions[posKey] = {
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

    // Detached window: fill toward the present when nearing the bottom
    // edge. Appending below doesn't move scrollTop, so no compensation.
    if (
      detached &&
      loadNewer &&
      container.scrollHeight -
        (container.scrollTop + container.clientHeight) <
        300
    ) {
      void loadNewer();
    }
  }, [loadMore, hasMore, fetching, posKey, checkIsAtBottom, detached, loadNewer]);

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
        scrollPositions[posKey] = {
          scrollTop: container.scrollTop,
          atBottom: isNearBottom(container)
        };
        // Flush immediately on unmount so it's saved before page unload
        persistScrollPositions();
      }
    };
  }, [posKey]);

  // Handle initial scroll after messages load
  useEffect(() => {
    if (!containerRef.current) return;

    // A jump owns the initial position — finishJump scrolls to the target
    // once it renders; restoring/scroll-to-bottom on top of that fights it.
    // This MUST be checked before the empty-messages guard below: on a jump
    // to an unloaded channel the first render has no messages, and finishJump
    // consumes the latch after its around-fetch — so if we waited for
    // messages, this effect would re-run post-fetch with the latch already
    // gone and scroll to the bottom, leaving the (highlighted) target
    // off-screen. Latch as soon as the jump is seen.
    if (!hasInitialScroll.current && peekPendingJump(channelId)) {
      hasInitialScroll.current = true;
      return;
    }

    if (fetching || messages.length === 0) return;

    if (!hasInitialScroll.current) {
      const saved = scrollPositions[posKey];

      const performScroll = () => {
        const container = containerRef.current;
        if (!container) return;

        // Always honor the bottom anchor over a stale scrollTop value —
        // scrollHeight may have changed since save time (more/fewer messages
        // loaded), so a saved scrollTop near the old bottom would land in
        // the middle of the new content. atBottom stays correct regardless.
        if (saved?.atBottom || saved === undefined) {
          // Discord behavior: if messages arrived since the last visit,
          // land on the "New messages" divider instead of the bottom.
          const divider = document.getElementById('new-messages-divider');
          if (divider) {
            divider.scrollIntoView({ block: 'center' });
            setIsAtBottom(checkIsAtBottom());
          } else {
            scrollToBottom();
          }
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
  }, [fetching, messages.length, scrollToBottom, channelId, posKey, checkIsAtBottom]);

  // auto-scroll on new messages if user is near bottom.
  // Depend on `messages.length`, NOT the whole `messages` array ref —
  // reactions, edits, and pin toggles mutate an existing message in
  // place, which still emits a new array ref through Redux Toolkit.
  // Keying on length ignores those in-place updates so reacting to an
  // older message while scrolled up doesn't snap the view to the bottom.
  // Real triggers (a new message arrives, a message is deleted) change
  // length and still drive the auto-follow behavior.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasInitialScroll.current || messages.length === 0)
      return;

    // Detached from the tail: never yank the view — the bottom of the
    // loaded window is mid-history, not the present.
    if (detached) return;

    // A jump owns the scroll while it settles. The around-fetch changes
    // messages.length here, but the detached flag it also sets propagates
    // a beat later (Redux message insert vs. local state) — without this
    // guard the auto-follow fires in that gap and scrolls the highlighted
    // target to the bottom (the "jumped, highlighted, off-screen" flake).
    if (peekPendingJump(channelId)) return;

    if (checkIsAtBottom()) {
      // scroll after a short delay to allow content to render
      setTimeout(() => {
        scrollToBottom();
      }, 10);
    }
  }, [messages.length, scrollToBottom, checkIsAtBottom, detached, channelId]);

  return {
    containerRef,
    onScroll,
    scrollToBottom,
    isAtBottom
  };
};

export { useScrollController };
