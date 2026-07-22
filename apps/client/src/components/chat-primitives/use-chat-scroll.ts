import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared scroll controller for both the channel and DM message lists —
 * position memory, load-more prepend compensation, near-bottom
 * auto-follow, the four-attempt restore ladder, and (channel-only)
 * detached-window paging + jump ownership + new-messages-divider
 * landing. Deduplicated from channel-view/text/use-scroll-controller.ts
 * and the inline DM copy.
 *
 * The caller supplies:
 * - `posKey`: the fully-qualified storage key for this list — channel
 *   `${serverPublicId}:${channelId}` (federation-scoped), DM
 *   `dm:${dmChannelId}`. MUST contain ':' (the loader treats non-colon
 *   keys as legacy and drops them).
 * - `storageKey`: which localStorage map to persist into (channels and
 *   DMs keep separate stores).
 * - `isJumpPending`: channel passes the jump engine's latch; DMs omit
 *   it (no jump-to-message).
 * - `landOnNewMessagesDivider`: channel lands on #new-messages-divider
 *   when unread; DMs have no divider.
 */

type TScrollPositionEntry = {
  scrollTop: number;
  atBottom: boolean;
};
type TScrollPositionMap = Record<string, TScrollPositionEntry>;

// One in-memory cache + persist timer per backing store.
const caches = new Map<LocalStorageKey, TScrollPositionMap>();
const timers = new Map<LocalStorageKey, ReturnType<typeof setTimeout>>();

function loadStore(storageKey: LocalStorageKey): TScrollPositionMap {
  const raw = getLocalStorageItemAsJSON<
    Record<string, number | TScrollPositionEntry>
  >(storageKey);
  if (!raw) return {};
  const out: TScrollPositionMap = {};
  for (const [k, v] of Object.entries(raw)) {
    // Legacy shapes (bare-number values, unscoped numeric keys) predate
    // the {scrollTop, atBottom} + `kind:id` convention and would restore
    // wrong positions — drop them.
    if (typeof v === 'number' || !k.includes(':')) continue;
    out[k] = v;
  }
  return out;
}

function getCache(storageKey: LocalStorageKey): TScrollPositionMap {
  let cache = caches.get(storageKey);
  if (!cache) {
    cache = loadStore(storageKey);
    caches.set(storageKey, cache);
  }
  return cache;
}

function persistStore(storageKey: LocalStorageKey) {
  setLocalStorageItemAsJSON(storageKey, getCache(storageKey));
}

function schedulePersist(storageKey: LocalStorageKey) {
  if (timers.has(storageKey)) return;
  timers.set(
    storageKey,
    setTimeout(() => {
      timers.delete(storageKey);
      persistStore(storageKey);
    }, 300)
  );
}

/**
 * "At bottom" as an absolute pixel distance. A `scrollHeight * ratio`
 * check scales with content: with a long history loaded, positions
 * several screens above the end still counted as "at bottom" — saved
 * positions restored to the wrong place and the auto-follow yanked the
 * view down while reading. 100px is roughly the last message group.
 */
const AT_BOTTOM_PX = 100;
function isNearBottom(container: HTMLElement): boolean {
  return (
    container.scrollHeight - (container.scrollTop + container.clientHeight) <
    AT_BOTTOM_PX
  );
}

type TUseChatScrollProps = {
  posKey: string;
  storageKey: LocalStorageKey;
  messages: unknown[];
  fetching: boolean;
  hasMore: boolean;
  loadMore: () => Promise<unknown>;
  detached?: boolean;
  loadNewer?: () => Promise<unknown>;
  isJumpPending?: () => boolean;
  landOnNewMessagesDivider?: boolean;
};

type TUseChatScrollReturn = {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  scrollToBottom: () => void;
  isAtBottom: boolean;
};

const useChatScroll = ({
  posKey,
  storageKey,
  messages,
  fetching,
  hasMore,
  loadMore,
  detached = false,
  loadNewer,
  isJumpPending,
  landOnNewMessagesDivider = false
}: TUseChatScrollProps): TUseChatScrollReturn => {
  const containerRef = useRef<HTMLDivElement>(null);
  const hasInitialScroll = useRef(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const checkIsAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    return isNearBottom(container);
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    getCache(storageKey)[posKey] = {
      scrollTop: container.scrollTop,
      atBottom: true
    };
    schedulePersist(storageKey);
    setIsAtBottom(true);
  }, [posKey, storageKey]);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || fetching) return;

    // Save position + whether the user is anchored at the bottom.
    // atBottom is load-bearing: scrollTop is absolute pixels and becomes
    // meaningless once scrollHeight grows, but atBottom stays correct
    // because it's relative.
    const atBottom = checkIsAtBottom();
    getCache(storageKey)[posKey] = {
      scrollTop: container.scrollTop,
      atBottom
    };
    schedulePersist(storageKey);

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
  }, [
    loadMore,
    hasMore,
    fetching,
    posKey,
    storageKey,
    checkIsAtBottom,
    detached,
    loadNewer
  ]);

  // Reset the "did we restore yet?" flag when the list changes. Without
  // this, switching A→B→A keeps the flag true from the A visit and the
  // restore branch below is skipped, leaving the user wherever the
  // browser placed scrollTop (typically 0 = top).
  useEffect(() => {
    hasInitialScroll.current = false;
  }, [posKey]);

  // Save scroll position on unmount.
  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (container) {
        getCache(storageKey)[posKey] = {
          scrollTop: container.scrollTop,
          atBottom: isNearBottom(container)
        };
        // Flush immediately on unmount so it's saved before page unload.
        persistStore(storageKey);
      }
    };
  }, [posKey, storageKey]);

  // Initial scroll after messages load.
  useEffect(() => {
    if (!containerRef.current) return;

    // A jump owns the initial position — finishJump scrolls to the
    // target once it renders; restoring on top of that fights it. This
    // MUST be checked before the empty-messages guard: on a jump to an
    // unloaded channel the first render has no messages, and finishJump
    // consumes the latch after its around-fetch — so if we waited for
    // messages, this effect would re-run post-fetch with the latch gone
    // and scroll to the bottom, leaving the (highlighted) target
    // off-screen. Latch as soon as the jump is seen.
    if (!hasInitialScroll.current && isJumpPending?.()) {
      hasInitialScroll.current = true;
      return;
    }

    if (fetching || messages.length === 0) return;

    if (!hasInitialScroll.current) {
      const saved = getCache(storageKey)[posKey];

      const performScroll = () => {
        const container = containerRef.current;
        if (!container) return;

        // Always honor the bottom anchor over a stale scrollTop —
        // scrollHeight may have changed since save time, so a saved
        // scrollTop near the old bottom would land mid-content.
        if (saved?.atBottom || saved === undefined) {
          const divider = landOnNewMessagesDivider
            ? document.getElementById('new-messages-divider')
            : null;
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

      // Ladder: immediate, next frame, then two timeouts for async media.
      performScroll();
      requestAnimationFrame(performScroll);
      setTimeout(performScroll, 50);
      setTimeout(performScroll, 200);
    }
  }, [
    fetching,
    messages.length,
    scrollToBottom,
    posKey,
    storageKey,
    checkIsAtBottom,
    isJumpPending,
    landOnNewMessagesDivider
  ]);

  // Auto-scroll on new messages if near bottom. Depend on
  // `messages.length`, NOT the whole array ref — reactions, edits, and
  // pin toggles mutate a message in place, which still emits a new array
  // ref through Redux Toolkit. Keying on length ignores those so
  // reacting to an older message while scrolled up doesn't snap to the
  // bottom. Real triggers (new message, deletion) change length.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !hasInitialScroll.current || messages.length === 0)
      return;

    // Detached from the tail: never yank — the bottom of the loaded
    // window is mid-history, not the present.
    if (detached) return;

    // A jump owns the scroll while it settles. The around-fetch changes
    // messages.length here, but the detached flag it also sets
    // propagates a beat later (Redux insert vs. local state) — without
    // this guard the auto-follow fires in that gap and scrolls the
    // highlighted target to the bottom.
    if (isJumpPending?.()) return;

    if (checkIsAtBottom()) {
      setTimeout(scrollToBottom, 10);
    }
  }, [messages.length, scrollToBottom, checkIsAtBottom, detached, isJumpPending]);

  return {
    containerRef,
    onScroll,
    scrollToBottom,
    isAtBottom
  };
};

export { useChatScroll };
