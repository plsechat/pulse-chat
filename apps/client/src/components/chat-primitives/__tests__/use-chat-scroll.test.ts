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
