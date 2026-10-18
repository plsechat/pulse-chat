/**
 * useDmMessages against the 300-message window: paging up past the cap
 * trims the newest end and detaches the window; `loadNewer` pages
 * toward the present from the newest LOADED message (dms.getMessages
 * `after`) and re-attaches when the server reports the tail — which is
 * also when the conversation counts as read (badge cleared, server
 * marker advanced); `reattach` replaces a detached window with the
 * latest page.
 *
 * Rendered with react-dom under happy-dom on the connection harness's
 * store; the harness's fake home client answers `dms.getMessages` from
 * a 1 000 message in-memory history. The harness is used (not a spy on
 * `@/lib/trpc`) because `mock.module` is process-wide in bun:test —
 * see src/__tests__/home-connection-harness.ts.
 *
 * Run via: bun test apps/client/src/features/dms/__tests__/use-dm-messages-window.test.tsx
 */
import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import type { TJoinedDmChannel, TJoinedDmMessage } from '@pulse/server/types';
import { MESSAGE_WINDOW_CAP } from '@/features/message-window';
import { dmsSliceActions } from '@/features/dms/slice';
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
const { useDmMessages } = await import('../use-dm-messages');

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const CHANNEL = 1;
const TOTAL = 1000;
// The DM route's default page size (the hook sends no limit).
const PAGE = 50;

const msg = (id: number) =>
  ({ id, dmChannelId: CHANNEL, userId: 2, content: `m${id}`, createdAt: id * 1000, e2ee: false, files: [], reactions: [] }) as unknown as TJoinedDmMessage;

/** ids `from..to` newest-first, as the server returns a page. */
const pageDesc = (from: number, to: number) => {
  const out: TJoinedDmMessage[] = [];
  for (let id = Math.min(to, TOTAL); id >= Math.max(from, 1); id--) out.push(msg(id));
  return out;
};

type TGetInput = { dmChannelId: number; cursor?: number | null; after?: number | null };

const getMessages = (raw: unknown) => {
  const input = raw as TGetInput;
  if (input.after != null) {
    const from = input.after / 1000 + 1;
    const to = from + PAGE - 1;
    return {
      messages: pageDesc(from, to),
      nextCursor: null,
      afterCursor: to < TOTAL ? Math.min(to, TOTAL) * 1000 : null
    };
  }
  const top = input.cursor != null ? input.cursor / 1000 - 1 : TOTAL;
  const from = top - PAGE + 1;
  return {
    messages: pageDesc(from, top),
    nextCursor: from > 1 ? from * 1000 : null,
    afterCursor: null
  };
};

type THook = ReturnType<typeof useDmMessages>;
const latest: { current: THook | null } = { current: null };

const Probe = () => {
  latest.current = useDmMessages(CHANNEL);
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
const lastQuery = () => home.callsTo('dms.getMessages').at(-1)?.input as TGetInput;
const unreadCount = () =>
  testStore.getState().dms.channels.find((c) => c.id === CHANNEL)?.unreadCount;

/** Page up until the window detaches from the live tail. */
const detach = async () => {
  // CAP / PAGE pages fill the window exactly; one more trims the newest end.
  for (let i = 0; i < MESSAGE_WINDOW_CAP / PAGE; i++) {
    await act(async () => {
      await hook().loadMore();
    });
  }
  expect(hook().detached).toBe(true);
};

beforeEach(() => {
  resetConnectionState();
  testStore.dispatch(dmsSliceActions.resetState());
  testStore.dispatch(
    dmsSliceActions.setChannels([
      { id: CHANNEL, isGroup: false, e2ee: false, members: [], unreadCount: 0 } as unknown as TJoinedDmChannel
    ])
  );
  home = fakeClient({
    'dms.getMessages': getMessages,
    'dms.markChannelAsRead': () => ({})
  });
  restoreClients = installClients({ home });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  restoreClients();
  testStore.dispatch(dmsSliceActions.resetState());
  latest.current = null;
});

describe('useDmMessages window', () => {
  test('mount loads the latest page attached, with older history flagged', async () => {
    await mount();
    expect(ids()[0]).toBe(TOTAL - PAGE + 1);
    expect(ids()[ids().length - 1]).toBe(TOTAL);
    expect(hook().hasMore).toBe(true);
    expect(hook().detached).toBe(false);
    expect(home.callsTo('dms.getMessages')[0].input).toEqual({ dmChannelId: CHANNEL });
  });

  test('paging up past the cap detaches; loadNewer pages from the newest loaded message and re-attaches at the tail', async () => {
    await mount();
    await detach();
    expect(ids()).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(ids()[0]).toBe(TOTAL - MESSAGE_WINDOW_CAP - PAGE + 1);
    expect(ids()[ids().length - 1]).toBe(TOTAL - PAGE);
    expect(hook().hasMore).toBe(true);

    // A live message arriving now is not stored and counts as unread
    // (the conversation is on screen but the message is not).
    await act(async () => {
      testStore.dispatch(
        dmsSliceActions.addMessages({
          dmChannelId: CHANNEL,
          messages: [msg(1001)],
          opts: { live: true }
        })
      );
      testStore.dispatch(dmsSliceActions.incrementChannelUnread(CHANNEL));
    });
    expect(ids()).not.toContain(1001);
    expect(unreadCount()).toBe(1);
    const readCallsBefore = home.callsTo('dms.markChannelAsRead').length;

    // Toward the present: `after` is the newest LOADED createdAt, the
    // reducer trims the oldest end, and the tail re-attaches.
    await act(async () => {
      await hook().loadNewer();
    });
    expect(lastQuery()).toEqual({ dmChannelId: CHANNEL, after: (TOTAL - PAGE) * 1000 });
    expect(ids()).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(ids()[0]).toBe(TOTAL - MESSAGE_WINDOW_CAP + 1);
    expect(ids()[ids().length - 1]).toBe(TOTAL);
    expect(hook().detached).toBe(false);
    expect(hook().hasMore).toBe(true);

    // Reaching the tail is what reads the conversation.
    expect(unreadCount()).toBe(0);
    expect(home.callsTo('dms.markChannelAsRead').length).toBe(readCallsBefore + 1);
    expect(home.callsTo('dms.markChannelAsRead').at(-1)?.input).toEqual({
      dmChannelId: CHANNEL
    });

    // Attached again: loadNewer is a no-op.
    const before = home.callsTo('dms.getMessages').length;
    await act(async () => {
      await hook().loadNewer();
    });
    expect(home.callsTo('dms.getMessages').length).toBe(before);
  });

  test('a forward page that does not reach the tail stays detached and unread', async () => {
    await mount();
    // Two extra pages up: the window ends 100 below the tail, so one
    // forward page (50) is not enough.
    await detach();
    await act(async () => {
      await hook().loadMore();
    });
    expect(ids()[ids().length - 1]).toBe(TOTAL - 2 * PAGE);
    testStore.dispatch(dmsSliceActions.incrementChannelUnread(CHANNEL));
    const readCallsBefore = home.callsTo('dms.markChannelAsRead').length;

    await act(async () => {
      await hook().loadNewer();
    });
    expect(ids()[ids().length - 1]).toBe(TOTAL - PAGE);
    expect(hook().detached).toBe(true);
    expect(unreadCount()).toBe(1);
    expect(home.callsTo('dms.markChannelAsRead').length).toBe(readCallsBefore);

    await act(async () => {
      await hook().loadNewer();
    });
    expect(ids()[ids().length - 1]).toBe(TOTAL);
    expect(hook().detached).toBe(false);
    expect(unreadCount()).toBe(0);
  });

  test('reattach replaces a detached window with the latest page', async () => {
    await mount();
    await detach();

    await act(async () => {
      await hook().reattach();
    });
    expect(lastQuery()).toEqual({ dmChannelId: CHANNEL });
    expect(ids()[0]).toBe(TOTAL - PAGE + 1);
    expect(ids()[ids().length - 1]).toBe(TOTAL);
    expect(hook().detached).toBe(false);
  });
});
