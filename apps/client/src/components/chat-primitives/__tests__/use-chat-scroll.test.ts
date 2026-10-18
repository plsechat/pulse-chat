/**
 * useChatScroll's persistence core and restore ladder — the scroll
 * memory the jump/scroll e2e spec exercises end to end:
 *   - restore honours the saved `atBottom` anchor over a stale scrollTop;
 *   - legacy store entries (bare numbers, unscoped keys) are ignored;
 *   - the debounced persist coalesces a burst of writes into one;
 *   - unmount flushes immediately.
 *
 * The hook is rendered with react-dom under happy-dom; the container's
 * scroll metrics are stubbed since there is no layout engine.
 *
 * Run via: bun test apps/client/src/components/chat-primitives/__tests__/use-chat-scroll.test.ts
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import * as storage from '@/helpers/storage';
import { LocalStorageKey } from '@/helpers/storage';
import { __testing, useChatScroll } from '../use-chat-scroll';

const { getCache, isNearBottom, loadStore, persistStore, reset, schedulePersist } = __testing;

const KEY = LocalStorageKey.SCROLL_POSITIONS;
const DM_KEY = LocalStorageKey.DM_SCROLL_POSITIONS;
const POS = 'srv-a:1';

const SCROLL_HEIGHT = 2000;
const CLIENT_HEIGHT = 500;

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const readStore = (key: LocalStorageKey) => {
  const raw = localStorage.getItem(key);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

beforeEach(() => {
  reset();
  localStorage.removeItem(KEY);
  localStorage.removeItem(DM_KEY);
});

afterEach(() => {
  reset();
  localStorage.removeItem(KEY);
  localStorage.removeItem(DM_KEY);
});

// --- persistence core -------------------------------------------------

describe('loadStore', () => {
  test('keeps {scrollTop, atBottom} entries under scoped keys', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ 'srv-a:1': { scrollTop: 10, atBottom: false }, 'dm:2': { scrollTop: 0, atBottom: true } })
    );
    expect(loadStore(KEY)).toEqual({
      'srv-a:1': { scrollTop: 10, atBottom: false },
      'dm:2': { scrollTop: 0, atBottom: true }
    });
  });

  test('drops legacy bare-number values and unscoped keys', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        'srv-a:1': 300,
        '5': { scrollTop: 1, atBottom: false },
        'srv-a:2': { scrollTop: 7, atBottom: true }
      })
    );
    expect(loadStore(KEY)).toEqual({ 'srv-a:2': { scrollTop: 7, atBottom: true } });
  });

  test('an absent store is empty', () => {
    expect(loadStore(KEY)).toEqual({});
  });
});

describe('getCache', () => {
  test('reads the store once and then serves the same object', () => {
    localStorage.setItem(KEY, JSON.stringify({ [POS]: { scrollTop: 10, atBottom: false } }));
    const first = getCache(KEY);
    localStorage.setItem(KEY, JSON.stringify({ [POS]: { scrollTop: 99, atBottom: false } }));
    expect(getCache(KEY)).toBe(first);
    expect(getCache(KEY)[POS]).toEqual({ scrollTop: 10, atBottom: false });
  });

  test('channel and DM stores are separate caches', () => {
    getCache(KEY)[POS] = { scrollTop: 1, atBottom: false };
    expect(getCache(DM_KEY)[POS]).toBeUndefined();
  });
});

describe('schedulePersist', () => {
  test('coalesces a burst of writes into one localStorage write with the latest value', async () => {
    const write = spyOn(storage, 'setLocalStorageItemAsJSON');
    try {
      getCache(KEY)[POS] = { scrollTop: 10, atBottom: false };
      schedulePersist(KEY);
      getCache(KEY)[POS] = { scrollTop: 20, atBottom: false };
      schedulePersist(KEY);
      getCache(KEY)[POS] = { scrollTop: 30, atBottom: true };
      schedulePersist(KEY);

      expect(readStore(KEY)).toBeNull();
      expect(write).not.toHaveBeenCalled();

      await sleep(400);

      expect(write).toHaveBeenCalledTimes(1);
      expect(readStore(KEY)).toEqual({ [POS]: { scrollTop: 30, atBottom: true } });
    } finally {
      write.mockRestore();
    }
  });

  test('a write after the debounce fires schedules a new one', async () => {
    getCache(KEY)[POS] = { scrollTop: 10, atBottom: false };
    schedulePersist(KEY);
    await sleep(400);
    getCache(KEY)[POS] = { scrollTop: 11, atBottom: false };
    schedulePersist(KEY);
    expect(readStore(KEY)).toEqual({ [POS]: { scrollTop: 10, atBottom: false } });
    await sleep(400);
    expect(readStore(KEY)).toEqual({ [POS]: { scrollTop: 11, atBottom: false } });
  });

  test('each backing store has its own timer', async () => {
    getCache(KEY)[POS] = { scrollTop: 1, atBottom: false };
    getCache(DM_KEY)['dm:9'] = { scrollTop: 2, atBottom: false };
    schedulePersist(KEY);
    schedulePersist(DM_KEY);
    await sleep(400);
    expect(readStore(KEY)).toEqual({ [POS]: { scrollTop: 1, atBottom: false } });
    expect(readStore(DM_KEY)).toEqual({ 'dm:9': { scrollTop: 2, atBottom: false } });
  });

  test('persistStore writes immediately', () => {
    getCache(KEY)[POS] = { scrollTop: 5, atBottom: false };
    persistStore(KEY);
    expect(readStore(KEY)).toEqual({ [POS]: { scrollTop: 5, atBottom: false } });
  });
});

describe('isNearBottom', () => {
  const container = (scrollTop: number) =>
    ({ scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT, scrollTop }) as HTMLElement;

  test('is an absolute pixel distance, not a ratio of the content height', () => {
    expect(isNearBottom(container(SCROLL_HEIGHT - CLIENT_HEIGHT))).toBe(true);
    expect(isNearBottom(container(SCROLL_HEIGHT - CLIENT_HEIGHT - 99))).toBe(true);
    expect(isNearBottom(container(SCROLL_HEIGHT - CLIENT_HEIGHT - 100))).toBe(false);
    expect(isNearBottom(container(0))).toBe(false);
  });
});

// --- the hook's restore ladder ---------------------------------------

type HookApi = ReturnType<typeof useChatScroll>;

/**
 * Mount the hook in a bare component whose container reports a fixed
 * scroll geometry. Returns the live container element and the hook's
 * API (re-captured on every render).
 */
async function mountHook(
  props: Partial<Parameters<typeof useChatScroll>[0]> = {}
): Promise<{ container: HTMLDivElement; api: () => HookApi; root: Root; host: HTMLDivElement }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  let latest: HookApi | null = null;
  let container: HTMLDivElement | null = null;

  const Harness = () => {
    latest = useChatScroll({
      posKey: POS,
      storageKey: KEY,
      messages: [1, 2, 3],
      fetching: false,
      hasMore: false,
      loadMore: async () => undefined,
      ...props
    });
    return createElement('div', {
      ref: (el: HTMLDivElement | null) => {
        // Ref callbacks run during commit, before the hook's effects:
        // the geometry is in place by the time the restore runs.
        if (el && el !== container) {
          Object.defineProperty(el, 'scrollHeight', { value: SCROLL_HEIGHT, configurable: true });
          Object.defineProperty(el, 'clientHeight', { value: CLIENT_HEIGHT, configurable: true });
          container = el;
        }
        latest!.containerRef.current = el;
      }
    });
  };

  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Harness));
  });
  // Let the four-step ladder (now, next frame, +50 ms, +200 ms) finish.
  await act(async () => {
    await sleep(260);
  });

  return { container: container!, api: () => latest!, root, host };
}

async function unmountHook(root: Root, host: HTMLDivElement) {
  await act(async () => {
    root.unmount();
  });
  host.remove();
}

describe('useChatScroll restore', () => {
  test('with no saved position the list opens at the bottom', async () => {
    const { container, api, root, host } = await mountHook();
    try {
      expect(container.scrollTop).toBe(SCROLL_HEIGHT);
      expect(api().isAtBottom).toBe(true);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('a saved atBottom anchor wins over its stale scrollTop', async () => {
    // Saved while the history was shorter: 300 px was the bottom then,
    // but it is mid-content now that more messages are loaded.
    localStorage.setItem(KEY, JSON.stringify({ [POS]: { scrollTop: 300, atBottom: true } }));
    const { container, api, root, host } = await mountHook();
    try {
      expect(container.scrollTop).toBe(SCROLL_HEIGHT);
      expect(api().isAtBottom).toBe(true);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('a saved position above the bottom is restored exactly', async () => {
    localStorage.setItem(KEY, JSON.stringify({ [POS]: { scrollTop: 300, atBottom: false } }));
    const { container, api, root, host } = await mountHook();
    try {
      expect(container.scrollTop).toBe(300);
      expect(api().isAtBottom).toBe(false);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('a legacy numeric entry is ignored, so the list opens at the bottom', async () => {
    localStorage.setItem(KEY, JSON.stringify({ [POS]: 300 }));
    const { container, root, host } = await mountHook();
    try {
      expect(container.scrollTop).toBe(SCROLL_HEIGHT);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('a pending jump owns the initial position: nothing is restored', async () => {
    localStorage.setItem(KEY, JSON.stringify({ [POS]: { scrollTop: 300, atBottom: false } }));
    const { container, root, host } = await mountHook({ isJumpPending: () => true });
    try {
      expect(container.scrollTop).toBe(0);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('unmount flushes the current position to localStorage immediately', async () => {
    const { container, api, root, host } = await mountHook();
    container.scrollTop = 700;
    await act(async () => {
      api().onScroll();
    });
    await unmountHook(root, host);
    expect(readStore(KEY)).toEqual({ [POS]: { scrollTop: 700, atBottom: false } });
  });

  test('onScroll records atBottom relative to the current geometry', async () => {
    const { container, api, root, host } = await mountHook();
    try {
      container.scrollTop = SCROLL_HEIGHT - CLIENT_HEIGHT - 20;
      await act(async () => {
        api().onScroll();
      });
      expect(api().isAtBottom).toBe(true);
      expect(getCache(KEY)[POS]).toEqual({
        scrollTop: SCROLL_HEIGHT - CLIENT_HEIGHT - 20,
        atBottom: true
      });

      container.scrollTop = 100;
      await act(async () => {
        api().onScroll();
      });
      expect(api().isAtBottom).toBe(false);
      expect(getCache(KEY)[POS]).toEqual({ scrollTop: 100, atBottom: false });
    } finally {
      await unmountHook(root, host);
    }
  });
});

// --- load-more compensation --------------------------------------------

/**
 * Prepending older rows must keep the row under the viewport where it
 * is. With the 300-message window, the same prepend can trim rows off
 * the BOTTOM, so a scrollHeight delta is not the amount the content
 * above moved; the hook anchors on the oldest row instead. happy-dom
 * has no layout, so each row's rect is derived from a layout table the
 * fake loadMore rewrites.
 */
describe('useChatScroll load-more compensation', () => {
  test('anchors on the oldest row, not on the scrollHeight delta', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    // Row top within the content, by row id.
    const layout: Record<string, number> = { 'msg-10': 0, 'msg-11': 100 };
    let scrollHeight = 200;
    let container: HTMLDivElement | null = null;
    let latest: HookApi | null = null;

    const rectFor = (el: HTMLElement) => {
      const top = (layout[el.id] ?? 0) - (container?.scrollTop ?? 0);
      return { top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    };

    const loadMore = async () => {
      // One older row lands above; the cap trims the newest off the
      // bottom: scrollHeight is unchanged although the content above
      // the anchor grew by 100.
      const older = document.createElement('div');
      older.id = 'msg-9';
      older.getBoundingClientRect = () => rectFor(older);
      container!.prepend(older);
      container!.querySelector('#msg-11')?.remove();
      Object.assign(layout, { 'msg-9': 0, 'msg-10': 100 });
      delete layout['msg-11'];
      scrollHeight = 200;
    };

    const Harness = () => {
      latest = useChatScroll({
        posKey: POS,
        storageKey: KEY,
        messages: [10, 11],
        fetching: false,
        hasMore: true,
        loadMore
      });
      return createElement('div', {
        ref: (el: HTMLDivElement | null) => {
          if (el && el !== container) {
            Object.defineProperty(el, 'scrollHeight', { get: () => scrollHeight, configurable: true });
            Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
            el.getBoundingClientRect = () => ({ top: 0, bottom: 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
            for (const id of ['msg-10', 'msg-11']) {
              const row = document.createElement('div');
              row.id = id;
              row.getBoundingClientRect = () => rectFor(row);
              el.appendChild(row);
            }
            container = el;
          }
          latest!.containerRef.current = el;
        }
      });
    };

    const root = createRoot(host);
    try {
      await act(async () => {
        root.render(createElement(Harness));
      });
      await act(async () => {
        await sleep(260);
      });

      // Near the top, slightly scrolled: msg-10 is the row in view.
      container!.scrollTop = 20;
      await act(async () => {
        latest!.onScroll();
        await sleep(0);
      });

      // The old scrollHeight formula would have left scrollTop at 20
      // (no height delta) and jumped the reader up by one row.
      expect(container!.scrollTop).toBe(120);
      expect(container!.querySelector('#msg-9')).not.toBeNull();
    } finally {
      await unmountHook(root, host);
    }
  });
});

// --- bottom-follow -----------------------------------------------------

/**
 * Following new arrivals is decided by the anchor the reader HAD (the
 * sticky flag), not by measuring after the new row is in the DOM: a
 * group taller than the near-bottom threshold used to measure as
 * "scrolled up" and the list stopped following. The follow is keyed on
 * the newest message id so it survives the 300-message window cap, and
 * a ResizeObserver re-pins the bottom when content grows late.
 *
 * This harness clamps scrollTop like a real scroll container (the
 * geometry above never clamps, which is what hid the bug) and lets a
 * test change the content height and re-render with a new tail.
 */
type TMessage = { id: number };

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

async function mountFollowHook(
  initial: TMessage[],
  props: Partial<Parameters<typeof useChatScroll>[0]> = {}
) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const geometry = { scrollHeight: SCROLL_HEIGHT, clientHeight: CLIENT_HEIGHT };
  let scrollTop = 0;
  let latest: HookApi | null = null;
  let container: HTMLDivElement | null = null;

  const Harness = ({ messages }: { messages: TMessage[] }) => {
    latest = useChatScroll({
      posKey: POS,
      storageKey: KEY,
      messages,
      fetching: false,
      hasMore: false,
      loadMore: async () => undefined,
      ...props
    });
    return createElement(
      'div',
      {
        ref: (el: HTMLDivElement | null) => {
          if (el && el !== container) {
            Object.defineProperty(el, 'scrollHeight', { get: () => geometry.scrollHeight, configurable: true });
            Object.defineProperty(el, 'clientHeight', { get: () => geometry.clientHeight, configurable: true });
            Object.defineProperty(el, 'scrollTop', {
              get: () => scrollTop,
              set: (value: number) => {
                scrollTop = Math.max(0, Math.min(value, geometry.scrollHeight - geometry.clientHeight));
              },
              configurable: true
            });
            container = el;
          }
          latest!.containerRef.current = el;
        }
      },
      createElement('div', { id: 'content' })
    );
  };

  const root = createRoot(host);
  const render = (messages: TMessage[]) =>
    act(async () => {
      root.render(createElement(Harness, { messages }));
    });
  await render(initial);
  await act(async () => {
    await sleep(260);
  });

  return { container: container!, api: () => latest!, geometry, render, root, host };
}

/** The reader scrolls up to `top` (a real scroll drives onScroll). */
async function scrollUpTo(container: HTMLDivElement, api: () => HookApi, top: number) {
  container.scrollTop = top;
  await act(async () => {
    api().onScroll();
  });
}

describe('useChatScroll bottom-follow', () => {
  const ORIGINAL_RESIZE_OBSERVER = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT;
  const THREE: TMessage[] = [{ id: 1 }, { id: 2 }, { id: 3 }];

  beforeEach(() => {
    FakeResizeObserver.instances = [];
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = ORIGINAL_RESIZE_OBSERVER;
  });

  test('a new group taller than the near-bottom threshold still follows', async () => {
    const { container, api, geometry, render, root, host } = await mountFollowHook(THREE);
    try {
      expect(container.scrollTop).toBe(BOTTOM);

      // 150 px of new content: measured after the fact, the reader is now
      // 150 px from the bottom — past the 100 px threshold.
      geometry.scrollHeight += 150;
      await render([...THREE, { id: 4 }]);

      expect(container.scrollTop).toBe(geometry.scrollHeight - CLIENT_HEIGHT);
      expect(api().isAtBottom).toBe(true);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('a new tail at a constant length (the window cap) follows', async () => {
    const { container, geometry, render, root, host } = await mountFollowHook(THREE);
    try {
      geometry.scrollHeight += 150;
      // The oldest row was trimmed as the newest arrived: same length.
      await render([{ id: 2 }, { id: 3 }, { id: 4 }]);
      expect(container.scrollTop).toBe(geometry.scrollHeight - CLIENT_HEIGHT);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('reactions and edits (same tail id) do not move the reader', async () => {
    const { container, api, render, root, host } = await mountFollowHook(THREE);
    try {
      await scrollUpTo(container, api, 300);
      // A new array ref with the same ids, as a reaction toggle emits.
      await render(THREE.map((m) => ({ ...m })));
      expect(container.scrollTop).toBe(300);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('scrolled up, a new arrival does not follow and the pill state says so', async () => {
    const { container, api, geometry, render, root, host } = await mountFollowHook(THREE);
    try {
      await scrollUpTo(container, api, 300);
      expect(api().isAtBottom).toBe(false);

      geometry.scrollHeight += 150;
      await render([...THREE, { id: 4 }]);

      expect(container.scrollTop).toBe(300);
      expect(api().isAtBottom).toBe(false);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('late growth re-pins the bottom while anchored, never while scrolled up', async () => {
    const { container, api, geometry, root, host } = await mountFollowHook(THREE);
    try {
      const [observer] = FakeResizeObserver.instances;
      expect(observer).toBeDefined();
      // The pane (composer-height changes) and its content are watched.
      expect(observer!.observed.has(container)).toBe(true);
      expect(observer!.observed.has(container.querySelector('#content')!)).toBe(true);

      // A link preview / image expands an existing row: no new message,
      // no scroll event — only the observer sees it.
      geometry.scrollHeight += 300;
      await act(async () => {
        observer!.fire();
      });
      expect(container.scrollTop).toBe(geometry.scrollHeight - CLIENT_HEIGHT);

      await scrollUpTo(container, api, 300);
      geometry.scrollHeight += 300;
      await act(async () => {
        observer!.fire();
      });
      expect(container.scrollTop).toBe(300);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('followNext follows the next arrival even when scrolled up', async () => {
    const { container, api, geometry, render, root, host } = await mountFollowHook(THREE);
    try {
      await scrollUpTo(container, api, 300);

      api().followNext();
      geometry.scrollHeight += 150;
      await render([...THREE, { id: 4 }]);

      expect(container.scrollTop).toBe(geometry.scrollHeight - CLIENT_HEIGHT);
      expect(api().isAtBottom).toBe(true);
    } finally {
      await unmountHook(root, host);
    }
  });

  test('detached from the tail nothing follows or re-pins', async () => {
    const { container, api, geometry, render, root, host } = await mountFollowHook(THREE, {
      detached: true
    });
    try {
      await scrollUpTo(container, api, 300);
      api().followNext();
      geometry.scrollHeight += 150;
      await render([...THREE, { id: 4 }]);
      expect(container.scrollTop).toBe(300);

      await scrollUpTo(container, api, BOTTOM + 150);
      const [observer] = FakeResizeObserver.instances;
      geometry.scrollHeight += 300;
      await act(async () => {
        observer!.fire();
      });
      expect(container.scrollTop).toBe(BOTTOM + 150);
    } finally {
      await unmountHook(root, host);
    }
  });
});
