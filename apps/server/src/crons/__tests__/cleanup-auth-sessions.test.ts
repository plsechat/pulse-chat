/**
 * cleanup-auth-sessions cron — expired local-auth session rows go,
 * live and revoked-but-unexpired rows stay (reuse detection needs the
 * latter), and a backlog larger than one batch drains completely.
 *
 * Setup is inline per test (no beforeEach) — see delete-account.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { localAuthSessions, localAuthUsers } from '../../db/schema';
import { cleanupExpiredAuthSessions } from '../cleanup-auth-sessions';

const DAY_MS = 24 * 60 * 60 * 1000;

const insertAuthUser = async () => {
  const id = randomUUIDv7();
  await getTestDb().insert(localAuthUsers).values({
    id,
    email: `sweep-${id.slice(0, 8)}@example.com`,
    passwordHash: 'not-a-real-hash',
    createdAt: Date.now()
  });
  return id;
};

const seedRows = async (
  userId: string,
  rows: { expiresAt: number; revokedAt?: number }[]
) => {
  const ids = rows.map(() => randomUUIDv7());
  await getTestDb().insert(localAuthSessions).values(
    rows.map((row, i) => ({
      id: ids[i]!,
      userId,
      familyId: randomUUIDv7(),
      createdAt: Date.now() - 31 * DAY_MS,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt ?? null
    }))
  );
  return ids;
};

const rowsOf = async (userId: string) =>
  getTestDb()
    .select({ id: localAuthSessions.id })
    .from(localAuthSessions)
    .where(eq(localAuthSessions.userId, userId));

describe('cleanup-auth-sessions cron', () => {
  test('removes expired rows and keeps live and revoked-but-unexpired ones', async () => {
    const userId = await insertAuthUser();
    const now = Date.now();
    const [expired, expiredRevoked, live, revokedLive] = await seedRows(userId, [
      { expiresAt: now - DAY_MS },
      { expiresAt: now - DAY_MS, revokedAt: now - 2 * DAY_MS },
      { expiresAt: now + DAY_MS },
      { expiresAt: now + DAY_MS, revokedAt: now - 60_000 }
    ]);

    const removed = await cleanupExpiredAuthSessions();

    expect(removed).toBe(2);
    const remaining = (await rowsOf(userId)).map((r) => r.id).sort();
    expect(remaining).toEqual([live!, revokedLive!].sort());
    expect(remaining).not.toContain(expired!);
    expect(remaining).not.toContain(expiredRevoked!);
  });

  test('a backlog larger than one batch is drained completely', async () => {
    const userId = await insertAuthUser();
    const now = Date.now();
    await seedRows(
      userId,
      Array.from({ length: 2500 }, () => ({ expiresAt: now - 60_000 }))
    );
    await seedRows(userId, [{ expiresAt: now + DAY_MS }]);

    const removed = await cleanupExpiredAuthSessions();

    expect(removed).toBe(2500);
    expect((await rowsOf(userId)).length).toBe(1);
  });

  test('a row exactly at the boundary is kept', async () => {
    const userId = await insertAuthUser();
    // Taken before the cron computes its cutoff, so strictly newer.
    await seedRows(userId, [{ expiresAt: Date.now() + 60_000 }]);

    expect(await cleanupExpiredAuthSessions()).toBe(0);
    expect((await rowsOf(userId)).length).toBe(1);
  });
});
