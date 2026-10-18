/**
 * The per-conversation message window (features/message-window.ts):
 * the 300-message cap, which end each merge direction trims, the
 * detached-window rule for live messages, and the latest-page replace
 * that re-attaches a window.
 *
 * Run via: bun test apps/client/src/features/__tests__/message-window.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  MESSAGE_WINDOW_CAP,
  mergeMessageWindow,
  replaceMessageWindow,
  windowOrDefault
} from '../message-window';

type TMsg = { id: number; createdAt: number };
const msg = (id: number): TMsg => ({ id, createdAt: id * 1000 });
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(from + i));
const ids = (list: TMsg[]) => list.map((m) => m.id);

describe('mergeMessageWindow', () => {
  test('a fresh conversation assumes older history and an attached tail', () => {
    expect(windowOrDefault(undefined)).toEqual({ hasOlder: true, hasNewer: false });
  });

  test('dedupes by id and orders by createdAt regardless of arrival', () => {
    const { messages } = mergeMessageWindow(
      [msg(2), msg(3)],
      [msg(3), msg(1), msg(4)],
      {},
      undefined
    );
    expect(ids(messages)).toEqual([1, 2, 3, 4]);
  });

  test('appending past the cap keeps the NEWEST 300 and flags older history', () => {
    let state = mergeMessageWindow<TMsg>([], range(1, 300), {}, undefined);
    expect(state.messages).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(state.window).toEqual({ hasOlder: true, hasNewer: false });

    // hasOlder came from the default; make it false to prove the trim sets it.
    state = mergeMessageWindow(state.messages, [msg(301)], {}, {
      hasOlder: false,
      hasNewer: false
    });
    expect(state.messages).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(state.messages[0].id).toBe(2);
    expect(state.messages[MESSAGE_WINDOW_CAP - 1].id).toBe(301);
    expect(state.window).toEqual({ hasOlder: true, hasNewer: false });
  });

  test('N > 300 live appends one at a time stay bounded with the newest kept', () => {
    let messages: TMsg[] = [];
    let window = windowOrDefault(undefined);
    for (let id = 1; id <= 450; id++) {
      ({ messages, window } = mergeMessageWindow(messages, [msg(id)], { live: true }, window));
    }
    expect(messages).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(ids(messages)).toEqual(ids(range(151, 450)));
    expect(window.hasOlder).toBe(true);
    expect(window.hasNewer).toBe(false);
  });

  test('prepending past the cap keeps the OLDEST 300 and detaches the window', () => {
    const loaded = range(201, 500);
    const { messages, window } = mergeMessageWindow(
      loaded,
      range(151, 200),
      { prepend: true },
      { hasOlder: true, hasNewer: false }
    );
    expect(messages).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(messages[0].id).toBe(151);
    expect(messages[MESSAGE_WINDOW_CAP - 1].id).toBe(450);
    expect(window).toEqual({ hasOlder: true, hasNewer: true });
  });

  test('a prepend within the cap leaves the window attached', () => {
    const { messages, window } = mergeMessageWindow(
      range(51, 100),
      range(1, 50),
      { prepend: true },
      { hasOlder: true, hasNewer: false }
    );
    expect(messages).toHaveLength(100);
    expect(window).toEqual({ hasOlder: true, hasNewer: false });
  });

  test('a live message is not stored while the window is detached', () => {
    const loaded = range(1, 10);
    const { messages, window } = mergeMessageWindow(loaded, [msg(999)], { live: true }, {
      hasOlder: true,
      hasNewer: true
    });
    expect(ids(messages)).toEqual(ids(loaded));
    expect(window.hasNewer).toBe(true);
  });

  test('a fetched newer page IS stored while detached (paging toward the present)', () => {
    const { messages } = mergeMessageWindow(range(1, 10), range(11, 20), {}, {
      hasOlder: true,
      hasNewer: true
    });
    expect(messages).toHaveLength(20);
  });
});

describe('replaceMessageWindow', () => {
  test('drops a detached window and re-attaches on the latest page', () => {
    const stale = range(1, 300);
    const { messages, window } = replaceMessageWindow(stale, range(951, 1000), true);
    expect(ids(messages)).toEqual(ids(range(951, 1000)));
    expect(window).toEqual({ hasOlder: true, hasNewer: false });
  });

  test('keeps a live message that landed while the page was in flight', () => {
    // 1001 arrived after the page's snapshot (newer than everything in it).
    const existing = [...range(1, 300), msg(1001)];
    const { messages } = replaceMessageWindow(existing, range(951, 1000), true);
    expect(messages[0].id).toBe(951);
    expect(messages[messages.length - 1].id).toBe(1001);
    expect(messages).toHaveLength(51);
  });

  test('the beginning of history is honoured when the page says so', () => {
    const { window } = replaceMessageWindow([], range(1, 20), false);
    expect(window).toEqual({ hasOlder: false, hasNewer: false });
  });

  test('an over-cap result is trimmed from the oldest end', () => {
    const existing = range(1, 400);
    const { messages, window } = replaceMessageWindow(existing, range(1, 50), false);
    expect(messages).toHaveLength(MESSAGE_WINDOW_CAP);
    expect(messages[0].id).toBe(101);
    expect(window).toEqual({ hasOlder: true, hasNewer: false });
  });
});
