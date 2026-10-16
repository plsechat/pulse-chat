/**
 * The overlay ↔ history stack: Back closes the newest overlay; an overlay
 * closed through its own UI pops its history entry so the next Back
 * leaves the app, not a phantom entry.
 *
 * Run via:
 *   bun test apps/client/src/lib/__tests__/overlay-history.test.ts
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { __testing, pushOverlay, releaseOverlay } from '@/lib/overlay-history';

type TLog = string[];

const fakeHistory = (log: TLog) => ({
  pushState: (state: unknown) =>
    log.push(`push:${(state as { pulseOverlay: number }).pulseOverlay}`),
  back: () => {
    log.push('back');
    // The browser answers history.back() with a popstate.
    __testing.handlePopState();
  }
});

let log: TLog;

beforeEach(() => {
  __testing.reset();
  log = [];
  __testing.setHistory(fakeHistory(log));
});

describe('overlay history', () => {
  test('a user Back closes the newest overlay only', () => {
    const closed: string[] = [];
    pushOverlay(() => closed.push('drawer'));
    pushOverlay(() => closed.push('sheet'));
    expect(__testing.depth()).toBe(2);

    __testing.handlePopState();
    expect(closed).toEqual(['sheet']);
    expect(__testing.depth()).toBe(1);

    __testing.handlePopState();
    expect(closed).toEqual(['sheet', 'drawer']);
    expect(__testing.depth()).toBe(0);
    expect(log).toEqual(['push:1', 'push:2']);
  });

  test('closing through the UI pops the history entry without a second close', () => {
    const closed: string[] = [];
    const id = pushOverlay(() => closed.push('drawer'));
    releaseOverlay(id);

    expect(log).toEqual(['push:1', 'back']);
    expect(closed).toEqual([]); // our own back() is not a user Back
    expect(__testing.depth()).toBe(0);

    // The next real Back reaches the app (nothing left to close).
    __testing.handlePopState();
    expect(closed).toEqual([]);
  });

  test('releasing an entry that Back already popped is a no-op', () => {
    const id = pushOverlay(() => {});
    __testing.handlePopState();
    releaseOverlay(id);
    expect(log).toEqual(['push:1']);
  });

  test('releasing a lower overlay keeps the one above it reachable by Back', () => {
    const closed: string[] = [];
    const drawer = pushOverlay(() => closed.push('drawer'));
    pushOverlay(() => closed.push('sheet'));
    releaseOverlay(drawer);
    // Not on top: no history navigation, the sheet still owns the top.
    expect(log).toEqual(['push:1', 'push:2']);
    __testing.handlePopState();
    expect(closed).toEqual(['sheet']);
  });
});
