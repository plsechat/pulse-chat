/**
 * useMessages against the 300-message window (D33): paging up past the
 * cap trims the newest end and detaches the window; `loadNewer` pages
 * toward the present from the newest LOADED message (the cursor is
 * derived from the window, not remembered from a page result) and
 * re-attaches when the server reports the tail; `reattach` replaces a
 * detached window with the latest page.
 *
 * The hook is rendered with react-dom under happy-dom on the connection
 * harness's store; the harness's fake home client answers
 * `messages.get` from a 1 000 message in-memory history. The harness is
 * used (not a spy on `@/lib/trpc`) because `mock.module` is process-wide
 * in bun:test and the lib/e2ee suites replace that module for the rest
 * of the run — see src/__tests__/home-connection-harness.ts.
 *
 * Run via: bun test apps/client/src/features/server/messages/__tests__/use-messages-window.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { DEFAULT_MESSAGES_LIMIT } from '@pulse/shared';
import type { TJoinedMessage } from '@pulse/server/types';
import { MESSAGE_WINDOW_CAP } from '@/features/message-window';
import { serverSliceActions } from '@/features/server/slice';
import {
  fakeClient,
  installClients,
  installConnectionMocks,
  resetConnectionState,
  testStore
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

// Imported after the mocks so the hook's `@/lib/trpc` / `@/features/store`
// bindings resolve to the harness's replacements.
const { useMessages } = await import('../hooks');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CHANNEL = 1;
const TOTAL = 1000;

const msg = (id: number) =>
  ({ id, channelId: CHANNEL, userId: 2, content: `m${id}`, createdAt: id * 1000, e2ee: false, files: [], reactions: [] }) as unknown as TJoinedMessage;

/** ids `from..to` newest-first, as the server returns a page. */
const pageDesc = (from: number, to: number) => {
  const out: TJoinedMessage[] = [];
  for (let id = Math.min(to, TOTAL); id >= Math.max(from, 1); id--) out.push(msg(id));
  return out;
};

type TGetInput = { cursor?: number | null; after?: number | null; aroundId?: number | null };

const getMessages = (raw: unknown) => {
  const input = raw as TGetInput;
  if (input.after != null) {
    const from = input.after / 1000 + 1;
    const to = from + DEFAULT_MESSAGES_LIMIT - 1;
    return {
      messages: pageDesc(from, to),
      nextCursor: null,
      afterCursor: to < TOTAL ? Math.min(to, TOTAL) * 1000 : null,
      authors: undefined
    };
  }
  const top = input.cursor != null ? input.cursor / 1000 - 1 : TOTAL;
  const from = top - DEFAULT_MESSAGES_LIMIT + 1;
  return {
    messages: pageDesc(from, top),
    nextCursor: from > 1 ? from * 1000 : null,
    afterCursor: null,
    authors: undefined
  };
};

type THook = ReturnType<typeof useMessages>;
const latest: { current: THook | null } = { current: null };

const Probe = () => {
  latest.current = useMessages(CHANNEL);
  return null;
};

let root: Root;
let container: HTMLDivElement;
let home: ReturnType<typeof fakeClient>;
let restoreClients: () => void;

const mount = async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Provider, { store: testStore, children: createElement(Probe) })
    );
  });
  // The initial fetch resolves through two awaits (query + decrypt).
  await act(async () => {
    await Promise.resolve();
  });
};

const ids = () => (latest.current?.messages ?? []).map((m) => m.id);
const hook = () => latest.current!;
const lastQuery = () => home.callsTo('messages.get').at(-1)?.input as TGetInput;

beforeEach(() => {
  resetConnectionState();
  home = fakeClient({ 'messages.get': getMessages });
  restoreClients = installClients({ home });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  restoreClients();
  testStore.dispatch(serverSliceActions.clearAllMessages());
  latest.current = null;
});

describe('useMessages window', () => {
  test('mount loads the latest page attached, with older history flagged', async () => {
    await mount();
    expect(ids()).toEqual(ids().slice().sort((a, b) => a - b));
    expect(ids()[0]).toBe(TOTAL - DEFAULT_MESSAGES_LIMIT + 1);
    expect(ids()[ids().length - 1]).toBe(TOTAL);
    expect(hook().hasMore).toBe(true);
    expect(hook().detached).toBe(false);
    expect(home.callsTo('messages.get')[0].input).toMatchObject({ cursor: null });
  });

  test('paging up past the cap detaches; loadNewer pages from the newest loaded message and re-attaches at the tail', async () => {
    await mount();

    // Two more pages fill the window exactly (3 × 100 = cap)...
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await hook().loadMore();
      });
    }
    expect(ids()).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(hook().detached).toBe(false);
    // ...and the cursor sent was the oldest loaded message's createdAt.
    expect(lastQuery()).toMatchObject({ cursor: 801 * 1000 });

    // One more page: the newest 100 are dropped and the window detaches.
    await act(async () => {
      await hook().loadMore();
    });
    expect(ids()).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(ids()[0]).toBe(601);
    expect(ids()[ids().length - 1]).toBe(900);
    expect(hook().detached).toBe(true);
    expect(hook().hasMore).toBe(true);

    // A live message arriving now is not stored.
    await act(async () => {
      testStore.dispatch(
        serverSliceActions.addMessages({
          channelId: CHANNEL,
          messages: [msg(1001)],
          opts: { live: true }
        })
      );
    });
    expect(ids()).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(ids()).not.toContain(1001);

    // Toward the present: `after` is the newest LOADED createdAt, the
    // reducer trims the oldest end, and the tail re-attaches.
    await act(async () => {
      await hook().loadNewer();
    });
    expect(lastQuery()).toMatchObject({ after: 900 * 1000 });
    expect(ids()).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(ids()[0]).toBe(701);
    expect(ids()[ids().length - 1]).toBe(TOTAL);
    expect(hook().detached).toBe(false);
    expect(hook().hasMore).toBe(true);

    // Attached again: loadNewer is a no-op.
    const before = home.callsTo('messages.get').length;
    await act(async () => {
      await hook().loadNewer();
    });
    expect(home.callsTo('messages.get').length).toBe(before);
  });

  test('reattach replaces a detached window with the latest page', async () => {
    await mount();
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await hook().loadMore();
      });
    }
    expect(hook().detached).toBe(true);

    await act(async () => {
      await hook().reattach();
    });
    expect(lastQuery()).toMatchObject({ cursor: null });
    expect(ids()[0]).toBe(TOTAL - DEFAULT_MESSAGES_LIMIT + 1);
    expect(ids()[ids().length - 1]).toBe(TOTAL);
    expect(hook().detached).toBe(false);
  });

  test('a fresh latest page keeps a live message that landed while it was in flight', async () => {
    await mount();
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        await hook().loadMore();
      });
    }
    expect(hook().detached).toBe(true);

    // The latest page's snapshot does not include 1001; the subscription
    // delivers it while the page is still in flight.
    await act(async () => {
      const pending = hook().reattach();
      testStore.dispatch(
        serverSliceActions.addMessages({
          channelId: CHANNEL,
          messages: [msg(1001)],
          opts: { live: true }
        })
      );
      await pending;
    });
    expect(ids()[ids().length - 1]).toBe(1001);
    expect(ids()[0]).toBe(TOTAL - DEFAULT_MESSAGES_LIMIT + 1);
    expect(hook().detached).toBe(false);
  });
});
