/**
 * Per-conversation message window: the loaded slice of a channel's or
 * DM's history, bounded in size and tracked for what lies beyond each
 * edge. Shared by features/server/slice.ts and features/dms/slice.ts
 * so both lists age out the same way.
 *
 * The Redux array for a conversation holds at most MESSAGE_WINDOW_CAP
 * messages. Without a bound, a long scroll-back (or a long-lived tab
 * receiving every live message) grows the array — and the rendered
 * DOM, since the list is not virtualised — for the whole session.
 *
 * Which end is dropped follows the direction the user is moving in:
 *  - prepending older pages drops the NEWEST end; the window is then
 *    detached from the live tail and `hasNewer` is set, so the scroll
 *    controller's load-newer / jump-to-present path brings it back;
 *  - appending (initial page, live messages, paging toward the
 *    present) drops the OLDEST end and sets `hasOlder`, so scrolling
 *    up fetches them again from the oldest message still loaded.
 *
 * A live message arriving while the window is detached is not stored:
 * it sits beyond the newest edge and would render as adjacent to
 * history it is not adjacent to. The unread/mention counters already
 * reflect it through read-state events; reattaching fetches it.
 */

export const MESSAGE_WINDOW_CAP = 300;

export type TMessageWindow = {
  /** Older messages exist above the oldest one loaded. */
  hasOlder: boolean;
  /** The window ends before the live tail; newer messages exist below. */
  hasNewer: boolean;
};

export type TMessageWindowMap = Record<number, TMessageWindow>;

export type TMergeMessagesOpts = {
  /** The page is older history and goes before what is loaded. */
  prepend?: boolean;
  /** A subscription message (present tense), not a fetched page. */
  live?: boolean;
};

type TWindowMessage = { id: number; createdAt: number };

const DEFAULT_WINDOW: TMessageWindow = { hasOlder: true, hasNewer: false };

/**
 * `window` for a conversation nothing has been fetched for yet: more
 * history is assumed until a page says otherwise, which is what the
 * list's "beginning of history" intro and the scroll-up trigger want.
 */
export const windowOrDefault = (window: TMessageWindow | undefined) =>
  window ?? DEFAULT_WINDOW;

/** Sort ascending by createdAt (oldest first), ties by id. */
const byCreatedAt = <T extends TWindowMessage>(a: T, b: T) =>
  a.createdAt - b.createdAt || a.id - b.id;

/**
 * Merge `incoming` into `existing` under the window rules above and
 * return the new array plus the window flags it implies. Pure: the
 * reducers assign the result.
 */
export function mergeMessageWindow<T extends TWindowMessage>(
  existing: readonly T[],
  incoming: readonly T[],
  opts: TMergeMessagesOpts,
  window: TMessageWindow | undefined
): { messages: T[]; window: TMessageWindow } {
  const current = windowOrDefault(window);

  if (opts.live && current.hasNewer) {
    return { messages: [...existing], window: current };
  }

  const existingIds = new Set(existing.map((m) => m.id));
  const fresh = incoming.filter((m) => !existingIds.has(m.id));
  const merged = (
    opts.prepend ? [...fresh, ...existing] : [...existing, ...fresh]
  ).sort(byCreatedAt);

  if (merged.length <= MESSAGE_WINDOW_CAP) {
    return { messages: merged, window: current };
  }

  if (opts.prepend) {
    return {
      messages: merged.slice(0, MESSAGE_WINDOW_CAP),
      window: { ...current, hasNewer: true }
    };
  }
  return {
    messages: merged.slice(merged.length - MESSAGE_WINDOW_CAP),
    window: { ...current, hasOlder: true }
  };
}

/**
 * Replace the window with a freshly fetched LATEST page and re-attach
 * it to the live tail. Existing messages at least as new as the page's
 * oldest entry are kept (a live message that landed while the page was
 * in flight is newer than the page and must survive); everything older
 * — a detached window, stale history — is dropped. The result is capped
 * from the oldest end like any append.
 */
export function replaceMessageWindow<T extends TWindowMessage>(
  existing: readonly T[],
  page: readonly T[],
  hasOlder: boolean
): { messages: T[]; window: TMessageWindow } {
  const sortedPage = [...page].sort(byCreatedAt);
  const oldest = sortedPage[0]?.createdAt;
  const kept =
    oldest === undefined
      ? []
      : existing.filter((m) => m.createdAt >= oldest);

  const pageIds = new Set(sortedPage.map((m) => m.id));
  const merged = [
    ...sortedPage,
    ...kept.filter((m) => !pageIds.has(m.id))
  ].sort(byCreatedAt);

  const overflow = merged.length - MESSAGE_WINDOW_CAP;
  return {
    messages: overflow > 0 ? merged.slice(overflow) : merged,
    window: { hasOlder: hasOlder || overflow > 0, hasNewer: false }
  };
}
