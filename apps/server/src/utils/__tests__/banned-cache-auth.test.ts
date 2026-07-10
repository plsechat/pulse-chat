/**
 * Integration test — banned-cache drives the tRPC auth middleware.
 *
 * Pre-Option-B, the auth middleware fetched the user row on every
 * protected procedure call to re-check the banned flag. Option B
 * replaces that DB query with an in-memory `Set` lookup, populated
 * at boot and invalidated by ban / unban mutations.
 *
 * This test covers the integration end-to-end:
 *   - calling `markBanned(userId)` causes the next protected call
 *     by that user to reject with FORBIDDEN
 *   - calling `markUnbanned(userId)` lets them through again
 *   - the public `users.ban` / `users.unban` mutations correctly
 *     propagate state into the cache
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';
import {
  _resetBannedCacheForTest,
  markBanned,
  markUnbanned
} from '../banned-cache';

afterEach(() => {
  _resetBannedCacheForTest();
});

describe('banned-cache → tRPC auth middleware', () => {
  test('markBanned causes the user\'s next protected call to reject', async () => {
    const { caller } = await initTest(1);

    // Sanity: user 1 can call a protected procedure.
    await expect(caller.users.getMyId()).resolves.toEqual({ userId: 1 });

    markBanned(1);

    await expect(caller.users.getMyId()).rejects.toThrow('User is banned');

    markUnbanned(1);

    // After unban the user can call again.
    await expect(caller.users.getMyId()).resolves.toEqual({ userId: 1 });
  });

  test('users.ban mutation propagates into the cache', async () => {
    // initTest() seeds users 1-3; user 1 is the server owner so they
    // can ban. Ban user 2 via the public mutation, then prove a
    // separate caller as user 2 is rejected by the auth middleware.
    const { caller: ownerCaller } = await initTest(1);

    await ownerCaller.users.ban({ userId: 2, reason: 'test' });

    // Build a caller as user 2 *after* the ban; their handshake +
    // joinServer paths are protected, so they should be rejected
    // without ever reaching the route logic.
    await expect(initTest(2)).rejects.toThrow('User is banned');
  });

  test('users.unban mutation removes from the cache', async () => {
    const { caller: ownerCaller } = await initTest(1);

    await ownerCaller.users.ban({ userId: 2, reason: 'test' });
    await expect(initTest(2)).rejects.toThrow('User is banned');

    await ownerCaller.users.unban({ userId: 2 });

    // After unban, user 2 can join again.
    await expect(initTest(2)).resolves.toBeDefined();
  });
});
