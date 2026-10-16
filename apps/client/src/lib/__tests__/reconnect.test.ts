/**
 * lib/reconnect — the one retry machine for the home socket.
 *
 *  - backoff is exponential with bounded jitter and capped
 *  - a ban, an account deletion or a revoked session never schedules
 *  - an attempt without an access token stops with "session expired"
 *  - a recoverable close schedules exactly one timer; stop clears it
 *
 * Run via: bun test apps/client/src/lib/__tests__/reconnect.test.ts
 */

import '@/lib/e2ee/__tests__/instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { DisconnectCode } from '@pulse/shared';
import {
  installConnectionMocks,
  resetConnectionState,
  testStore
} from '@/__tests__/home-connection-harness';

installConnectionMocks();

const reconnect = await import('@/lib/reconnect');
const supabase = await import('@/lib/supabase');
const { __testing } = reconnect;

beforeEach(() => {
  resetConnectionState();
});

afterEach(() => {
  reconnect.stopReconnecting();
});

describe('getDelay', () => {
  test('is base·2^n plus jitter below one base, capped', () => {
    const { getDelay, BASE_DELAY_MS, MAX_DELAY_MS } = __testing;
    for (let attempt = 0; attempt <= 10; attempt++) {
      const exponential = BASE_DELAY_MS * 2 ** attempt;
      for (let sample = 0; sample < 20; sample++) {
        const delay = getDelay(attempt);
        expect(delay).toBeGreaterThanOrEqual(Math.min(exponential, MAX_DELAY_MS));
        expect(delay).toBeLessThan(
          Math.min(exponential + BASE_DELAY_MS, MAX_DELAY_MS + 1)
        );
        expect(delay).toBeLessThanOrEqual(MAX_DELAY_MS);
      }
    }
  });

  test('lower bounds are monotone over attempts', () => {
    const { getDelay } = __testing;
    let previousFloor = 0;
    for (let attempt = 0; attempt <= 10; attempt++) {
      const floor = Math.min(...Array.from({ length: 20 }, () => getDelay(attempt)));
      expect(floor).toBeGreaterThanOrEqual(previousFloor);
      previousFloor = floor;
    }
  });
});

describe('startReconnecting', () => {
  test.each([
    DisconnectCode.BANNED,
    DisconnectCode.ACCOUNT_DELETED,
    DisconnectCode.SESSION_REVOKED
  ])('code %i never schedules a retry', (code) => {
    reconnect.startReconnecting(code);

    expect(reconnect.isCurrentlyReconnecting()).toBe(false);
    expect(__testing.hasPendingTimer()).toBe(false);
    expect(testStore.getState().server.reconnecting).toBe(false);
  });

  test('a recoverable code schedules one timer and flags the UI', () => {
    reconnect.startReconnecting(DisconnectCode.UNEXPECTED);

    expect(reconnect.isCurrentlyReconnecting()).toBe(true);
    expect(__testing.hasPendingTimer()).toBe(true);
    const { server } = testStore.getState();
    expect(server.reconnecting).toBe(true);
    expect(server.connected).toBe(false);

    // A second close while the loop runs does not start another loop.
    reconnect.startReconnecting(DisconnectCode.SERVER_SHUTDOWN);
    expect(__testing.hasPendingTimer()).toBe(true);

    reconnect.stopReconnecting();
    expect(reconnect.isCurrentlyReconnecting()).toBe(false);
    expect(__testing.hasPendingTimer()).toBe(false);
    expect(testStore.getState().server.reconnecting).toBe(false);
  });

  test('does nothing without a session to resume', async () => {
    const { serverSliceActions } = await import('@/features/server/slice');
    testStore.dispatch(serverSliceActions.setInfo(undefined));
    reconnect.startReconnecting(DisconnectCode.UNEXPECTED);
    expect(reconnect.isCurrentlyReconnecting()).toBe(false);
    expect(__testing.hasPendingTimer()).toBe(false);
  });
});

describe('attemptReconnect', () => {
  test('stops with "session expired" when there is no access token', async () => {
    const token = spyOn(supabase, 'getAccessToken').mockResolvedValue(null);
    try {
      reconnect.startReconnecting(DisconnectCode.UNEXPECTED);
      await __testing.attemptReconnect();

      expect(reconnect.isCurrentlyReconnecting()).toBe(false);
      expect(__testing.hasPendingTimer()).toBe(false);
      const { server } = testStore.getState();
      expect(server.connected).toBe(false);
      expect(server.reconnecting).toBe(false);
      expect(server.disconnectInfo).toMatchObject({
        code: DisconnectCode.UNEXPECTED,
        reason: 'Session expired. Please sign in again.',
        wasClean: false
      });
      expect(server.reconnectAttempt).toBe(0);
    } finally {
      token.mockRestore();
    }
  });

  test('is a no-op when no loop is running', async () => {
    const token = spyOn(supabase, 'getAccessToken').mockResolvedValue(null);
    try {
      await __testing.attemptReconnect();
      expect(testStore.getState().server.disconnectInfo).toBeUndefined();
    } finally {
      token.mockRestore();
    }
  });
});
