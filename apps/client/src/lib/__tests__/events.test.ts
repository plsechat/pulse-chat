/**
 * The typed in-process event bus: delivery, unsubscribe, handler
 * isolation (one throwing handler must not starve the rest) and
 * mutation of the listener set during an emit.
 *
 * Run via: bun test apps/client/src/lib/__tests__/events.test.ts
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
  dispatchForwardMessage,
  dispatchMentionUser,
  emitAppEvent,
  onAppEvent
} from '../events';

// The listener map is module-global; every subscription made here is
// torn down so nothing leaks into later files in the same process.
const subscriptions: (() => void)[] = [];
const subscribe: typeof onAppEvent = (event, handler) => {
  const off = onAppEvent(event, handler);
  subscriptions.push(off);
  return off;
};

afterEach(() => {
  for (const off of subscriptions.splice(0)) off();
});

describe('onAppEvent / emitAppEvent', () => {
  test('delivers the payload to every handler of that event only', () => {
    const a: unknown[] = [];
    const b: unknown[] = [];
    const other: unknown[] = [];
    subscribe('notes-changed', (p) => a.push(p));
    subscribe('notes-changed', (p) => b.push(p));
    subscribe('invites-changed', () => other.push('x'));

    emitAppEvent('notes-changed', { targetUserId: 7 });

    expect(a).toEqual([{ targetUserId: 7 }]);
    expect(b).toEqual([{ targetUserId: 7 }]);
    expect(other).toEqual([]);
  });

  test('payload-less events deliver undefined', () => {
    const seen: unknown[] = [];
    subscribe('threads-changed', (p) => seen.push(p));
    emitAppEvent('threads-changed');
    expect(seen).toEqual([undefined]);
  });

  test('emitting with no listeners is a no-op', () => {
    expect(() => emitAppEvent('pinned-messages-changed', { channelId: 1 })).not.toThrow();
  });

  test('the returned function unsubscribes; calling it twice is harmless', () => {
    let calls = 0;
    const off = subscribe('invites-changed', () => calls++);
    emitAppEvent('invites-changed');
    off();
    off();
    emitAppEvent('invites-changed');
    expect(calls).toBe(1);
  });

  test('a throwing handler is isolated and logged; the others still run', () => {
    const error = spyOn(console, 'error').mockImplementation(() => undefined);
    const order: string[] = [];
    subscribe('threads-changed', () => order.push('first'));
    subscribe('threads-changed', () => {
      throw new Error('boom');
    });
    subscribe('threads-changed', () => order.push('third'));

    expect(() => emitAppEvent('threads-changed')).not.toThrow();

    expect(order).toEqual(['first', 'third']);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('threads-changed');
    error.mockRestore();
  });

  test('unsubscribing another handler during an emit does not skip it this round', () => {
    const order: string[] = [];
    let offB: () => void = () => undefined;
    subscribe('invites-changed', () => {
      order.push('a');
      offB();
    });
    offB = subscribe('invites-changed', () => order.push('b'));

    emitAppEvent('invites-changed');
    expect(order).toEqual(['a', 'b']);

    emitAppEvent('invites-changed');
    expect(order).toEqual(['a', 'b', 'a']);
  });

  test('subscribing during an emit does not run the new handler this round', () => {
    const order: string[] = [];
    subscribe('invites-changed', () => {
      order.push('a');
      subscribe('invites-changed', () => order.push('late'));
    });

    emitAppEvent('invites-changed');
    expect(order).toEqual(['a']);

    emitAppEvent('invites-changed');
    expect(order).toEqual(['a', 'a', 'late']);
  });

  test('a handler unsubscribing itself only fires once', () => {
    let calls = 0;
    const off = subscribe('threads-changed', () => {
      calls++;
      off();
    });
    emitAppEvent('threads-changed');
    emitAppEvent('threads-changed');
    expect(calls).toBe(1);
  });
});

describe('legacy-named dispatch helpers', () => {
  test('dispatchMentionUser emits mention-user', () => {
    const seen: unknown[] = [];
    subscribe('mention-user', (p) => seen.push(p));
    dispatchMentionUser(4, 'dana');
    expect(seen).toEqual([{ userId: 4, username: 'dana' }]);
  });

  test('dispatchForwardMessage emits forward-message', () => {
    const seen: unknown[] = [];
    subscribe('forward-message', (p) => seen.push(p));
    dispatchForwardMessage(null, 'dm', 9);
    expect(seen).toEqual([{ content: null, sourceKind: 'dm', sourceId: 9 }]);
  });
});
