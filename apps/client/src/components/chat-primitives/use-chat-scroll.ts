import {
  getLocalStorageItemAsJSON,
  LocalStorageKey,
  setLocalStorageItemAsJSON
} from '@/helpers/storage';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react';

/**
 * Shared scroll controller for both the channel and DM message lists —
 * position memory, load-more prepend compensation, bottom-follow (a
 * sticky "the user was at the bottom" flag plus a ResizeObserver that
 * keeps the bottom pinned through late growth), the four-attempt
 * restore ladder, and (channel-only) detached-window paging + jump
 * ownership + new-messages-divider landing. Deduplicated from
 * channel-view/text/use-scroll-controller.ts and the inline DM copy.
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

// Entries are keyed per channel ever visited — across servers left long
// ago — so the map only grows. Writes re-insert the key (object key order
// is insertion order), which makes "most recent" the tail; persisting
// keeps that many and drops the oldest.
export const MAX_PERSISTED_POSITIONS = 200;

function rememberPosition(
  storageKey: LocalStorageKey,
  posKey: string,
  entry: TScrollPositionEntry
) {
  const cache = getCache(storageKey);
  delete cache[posKey];
  cache[posKey] = entry;
}

export function pruneToMostRecent(
  map: TScrollPositionMap,
  limit: number
): TScrollPositionMap {
  const keys = Object.keys(map);
  if (keys.length <= limit) return map;
  const out: TScrollPositionMap = {};
  for (const k of keys.slice(keys.length - limit)) out[k] = map[k];
  return out;
}

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
  const pruned = pruneToMostRecent(getCache(storageKey), MAX_PERSISTED_POSITIONS);
  caches.set(storageKey, pruned);
  setLocalStorageItemAsJSON(storageKey, pruned);
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

// Message rows carry `id="msg-<id>"` (channels) / `id="dm-msg-<id>"`
// (DMs) — the same anchors the jump engine scrolls to. The first match
// in document order is the oldest loaded row.
const MESSAGE_ROW_SELECTOR = '[id^="msg-"],[id^="dm-msg-"]';

/** `el`'s top edge relative to the top of `container`'s content. */
function offsetWithin(el: HTMLElement, container: HTMLElement): number {
  return (
    el.getBoundingClientRect().top -
    container.getBoundingClientRect().top +
    container.scrollTop
  );
}

/**
 * Identity of the newest loaded message. The follow effect keys on this
 * rather than on `messages.length`: at the 300-message window cap every
 * arrival also trims the oldest row, so the length never changes there
 * and a length-keyed effect stopped following exactly in the busiest
 * channels. Reactions, edits and pin toggles keep the id, so they still
 * do not snap a reader who is scrolled up.
 */
function tailKeyOf(messages: readonly unknown[]): unknown {
  const last = messages[messages.length - 1];
  if (last && typeof last === 'object' && 'id' in last) {
    return (last as { id: unknown }).id;
  }
  return last ?? messages.length;
}

/**
 * How long a `followNext()` request stays armed. The composer arms it
 * right before the send request; the echo normally lands within a
 * round-trip, and a send that failed must not leave the next unrelated
 * arrival pulling the reader down minutes later.
 */
const FOLLOW_NEXT_WINDOW_MS = 5_000;

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
  /**
   * Follow the next arrival even if the reader is scrolled up — called
   * by the composer's send paths so the author's own echo always lands
   * in view.
   */
  followNext: () => void;
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

  // Whether the reader is anchored at the bottom, recorded at the moments
  // that decide it (their own scroll, a programmatic scroll-to-bottom,
  // the restore ladder) instead of measured after new content is in the
  // DOM. A post-render measurement failed whenever the new group was
  // taller than the near-bottom threshold — an author header plus a few
  // wrapped lines in the narrow deck pane, an attachment, a card — and
  // the list silently stopped following.
  const stickRef = useRef(true);
  const followUntilRef = useRef(0);
  // Latest values for the ResizeObserver callback, which outlives renders.
  const detachedRef = useRef(detached);
  detachedRef.current = detached;
  const isJumpPendingRef = useRef(isJumpPending);
  isJumpPendingRef.current = isJumpPending;

  const checkIsAtBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return true;
    return isNearBottom(container);
  }, []);

  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
    stickRef.current = true;
    rememberPosition(storageKey, posKey, {
      scrollTop: container.scrollTop,
      atBottom: true
    });
    schedulePersist(storageKey);
    setIsAtBottom(true);
  }, [posKey, storageKey]);

  const followNext = useCallback(() => {
    followUntilRef.current = Date.now() + FOLLOW_NEXT_WINDOW_MS;
  }, []);

  const onScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container || fetching) return;

    // Save position + whether the user is anchored at the bottom.
    // atBottom is load-bearing: scrollTop is absolute pixels and becomes
    // meaningless once scrollHeight grows, but atBottom stays correct
    // because it's relative.
    const atBottom = checkIsAtBottom();
    stickRef.current = atBottom;
    rememberPosition(storageKey, posKey, {
      scrollTop: container.scrollTop,
      atBottom
    });
    schedulePersist(storageKey);

    setIsAtBottom(atBottom);

    if (container.scrollTop <= 50 && hasMore) {
      // Keep the row under the viewport where it is while older
      // messages land above it. Measured against the oldest message row
      // rather than scrollHeight: the 300-message cap trims rows off
      // the BOTTOM on the same prepend, so a height delta would also
      // count what was removed below the fold and land short.
      const anchor = container.querySelector<HTMLElement>(MESSAGE_ROW_SELECTOR);
      const anchorTop = anchor ? offsetWithin(anchor, container) : null;
      const prevScrollHeight = container.scrollHeight;

      loadMore().then(() => {
        const sameAnchor = anchor?.isConnected ? anchor : null;
        if (sameAnchor && anchorTop !== null) {
          container.scrollTop += offsetWithin(sameAnchor, container) - anchorTop;
          return;
        }
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

  // Content that grows after it rendered — link previews, images
  // decoding, command/watch cards updating, content-visibility
  // placeholders taking their real size — pushes the bottom away without
  // a scroll event or a new message. While the reader is anchored at the
  // bottom, every size change of the pane or of its content re-pins the
  // bottom edge. Observing the pane itself covers composer-height
  // changes (multiline input, attachment strip) that shrink the viewport
  // from below. One observer per container element, created lazily: the
  // pane mounts after the skeleton, not with the hook.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedContainerRef = useRef<HTMLElement | null>(null);

  const observeContent = useCallback(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    if (observedContainerRef.current !== container) {
      resizeObserverRef.current?.disconnect();
      const observer = new ResizeObserver(() => {
        const current = containerRef.current;
        if (!current || !stickRef.current) return;
        if (detachedRef.current || isJumpPendingRef.current?.()) return;
        current.scrollTop = current.scrollHeight;
      });
      observer.observe(container);
      resizeObserverRef.current = observer;
      observedContainerRef.current = container;
    }

    // Message groups are the pane's direct children (the DM pane has one
    // wrapper child); observing an element twice is a no-op, removed
    // children drop out on their own.
    const observer = resizeObserverRef.current!;
    for (const child of Array.from(container.children)) {
      observer.observe(child);
    }
  }, []);

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      observedContainerRef.current = null;
    },
    []
  );

  // Reset the "did we restore yet?" flag when the list changes. Without
  // this, switching A→B→A keeps the flag true from the A visit and the
  // restore branch below is skipped, leaving the user wherever the
  // browser placed scrollTop (typically 0 = top). A fresh list opens
  // anchored until the restore says otherwise.
  useEffect(() => {
    hasInitialScroll.current = false;
    stickRef.current = true;
  }, [posKey]);

  // Save scroll position on unmount.
  useEffect(() => {
    const container = containerRef.current;
    return () => {
      if (container) {
        rememberPosition(storageKey, posKey, {
          scrollTop: container.scrollTop,
          atBottom: isNearBottom(container)
        });
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
      // The target sits mid-history; nothing may pin the bottom until
      // the reader scrolls there.
      stickRef.current = false;
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
            const atBottom = checkIsAtBottom();
            stickRef.current = atBottom;
            setIsAtBottom(atBottom);
          } else {
            scrollToBottom();
          }
        } else {
          container.scrollTop = saved.scrollTop;
          const atBottom = checkIsAtBottom();
          stickRef.current = atBottom;
          setIsAtBottom(atBottom);
        }
        hasInitialScroll.current = true;
      };

      // Ladder: immediate, next frame, then two timeouts for async media.
      performScroll();
      // Observe only once the first rung has decided the anchor: the
      // observer's initial notification would otherwise pin the bottom
      // before a saved mid-history position is restored.
      observeContent();
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
    landOnNewMessagesDivider,
    observeContent
  ]);

  // Follow new arrivals while anchored at the bottom (or when the
  // composer asked to follow its own echo). A layout effect, so the pin
  // lands before the frame paints — no flash of the old bottom, and no
  // window for a late measurement to disagree with the anchor the
  // reader actually had.
  const tailKey = tailKeyOf(messages);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !hasInitialScroll.current || messages.length === 0)
      return;

    // New groups mean new children to watch for late growth.
    observeContent();

    // Detached from the tail: never yank — the bottom of the loaded
    // window is mid-history, not the present.
    if (detached) return;

    // A jump owns the scroll while it settles. The around-fetch changes
    // the tail here, but the detached flag it also sets propagates a
    // beat later (Redux insert vs. local state) — without this guard the
    // auto-follow fires in that gap and scrolls the highlighted target
    // to the bottom.
    if (isJumpPending?.()) return;

    const armed = followUntilRef.current > Date.now();
    if (armed || stickRef.current) {
      followUntilRef.current = 0;
      scrollToBottom();
    }
    // `messages.length` is only an emptiness guard; the tail id is what
    // identifies an arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tailKey, scrollToBottom, detached, isJumpPending, observeContent]);

  return {
    containerRef,
    onScroll,
    scrollToBottom,
    followNext,
    isAtBottom
  };
};

/**
 * Persistence core for unit tests. `reset` drops the module-global
 * caches and any pending persist timer so one test's state cannot leak
 * into the next.
 */
const __testing = {
  loadStore,
  getCache,
  schedulePersist,
  persistStore,
  isNearBottom,
  reset: () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    caches.clear();
  }
};

export { useChatScroll, __testing };
