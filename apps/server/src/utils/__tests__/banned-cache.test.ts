/**
 * Banned-user cache — read-side fast path that replaces the per-call
 * `getUserById` lookup in the tRPC auth middleware. This test covers
 * the cache surface in isolation; the integration with `protected
 * Procedure` is covered by `banned-cache-auth.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { users } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import {
  _bannedCacheSize,
  _isBannedCacheLoaded,
  _resetBannedCacheForTest,
  isBanned,
  loadBannedUsersCache,
  markBanned,
  markUnbanned
} from '../banned-cache';

afterEach(() => {
  _resetBannedCacheForTest();
});

describe('banned-cache', () => {
  test('isBanned returns false for unknown users before load', () => {
    expect(_isBannedCacheLoaded()).toBe(false);
    expect(isBanned(999)).toBe(false);
  });

  test('markBanned then isBanned returns true', () => {
    markBanned(42);
    expect(isBanned(42)).toBe(true);
    expect(isBanned(43)).toBe(false);
  });

  test('markUnbanned removes from set', () => {
    markBanned(42);
    expect(isBanned(42)).toBe(true);
    markUnbanned(42);
    expect(isBanned(42)).toBe(false);
  });

  test('mark / unmark are idempotent', () => {
    markBanned(7);
    markBanned(7);
    expect(_bannedCacheSize()).toBe(1);
    markUnbanned(7);
    markUnbanned(7);
    expect(_bannedCacheSize()).toBe(0);
  });

  test('loadBannedUsersCache populates from DB rows where banned=true', async () => {
    await initTest(1);

    // Seed two banned users alongside the standard fixture.
    const [a] = await db
      .insert(users)
      .values({
        supabaseId: 'banned-a',
        name: 'Banned A',
        publicId: 'pid-banned-a',
        banned: true,
        bannedAt: Date.now(),
        createdAt: Date.now()
      })
      .returning();
    const [b] = await db
      .insert(users)
      .values({
        supabaseId: 'banned-b',
        name: 'Banned B',
        publicId: 'pid-banned-b',
        banned: true,
        bannedAt: Date.now(),
        createdAt: Date.now()
      })
      .returning();

    await loadBannedUsersCache();

    expect(_isBannedCacheLoaded()).toBe(true);
    expect(isBanned(a!.id)).toBe(true);
    expect(isBanned(b!.id)).toBe(true);
    // Test fixture user 1 is not banned — should not be in the set.
    expect(isBanned(1)).toBe(false);
  });

  test('loadBannedUsersCache rebuilds from current DB state on re-call', async () => {
    await initTest(1);

    const [a] = await db
      .insert(users)
      .values({
        supabaseId: 'banned-c',
        name: 'Banned C',
        publicId: 'pid-banned-c',
        banned: true,
        bannedAt: Date.now(),
        createdAt: Date.now()
      })
      .returning();

    await loadBannedUsersCache();
    expect(isBanned(a!.id)).toBe(true);

    // Unban in DB, re-run loader — set should reflect the new state.
    await db
      .update(users)
      .set({ banned: false, banReason: null })
      .where(eq(users.id, a!.id));

    await loadBannedUsersCache();
    expect(isBanned(a!.id)).toBe(false);
  });
});
