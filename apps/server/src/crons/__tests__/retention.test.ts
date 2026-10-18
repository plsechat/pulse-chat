import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { tdb } from '../../__tests__/setup';
import { activityLog, logins, users } from '../../db/schema';
import { pruneExpiredLogs } from '../retention';

const DAY_MS = 24 * 60 * 60 * 1000;

const anyUserId = async () => {
  const [user] = await tdb
    .select({ id: users.id })
    .from(users)
    .orderBy(users.id)
    .limit(1);
  return user!.id;
};

const seedRows = async (ages: { old: number; fresh: number }) => {
  const userId = await anyUserId();

  const now = Date.now();
  const oldAt = now - 120 * DAY_MS;
  const freshAt = now - 5 * DAY_MS;

  const loginRows = [
    ...Array.from({ length: ages.old }, () => ({
      userId,
      ip: '127.0.0.1',
      createdAt: oldAt
    })),
    ...Array.from({ length: ages.fresh }, () => ({
      userId,
      ip: '127.0.0.1',
      createdAt: freshAt
    }))
  ];
  const activityRows = [
    ...Array.from({ length: ages.old }, () => ({
      userId,
      type: 'TEST',
      createdAt: oldAt
    })),
    ...Array.from({ length: ages.fresh }, () => ({
      userId,
      type: 'TEST',
      createdAt: freshAt
    }))
  ];

  if (loginRows.length > 0) await tdb.insert(logins).values(loginRows);
  if (activityRows.length > 0) await tdb.insert(activityLog).values(activityRows);

  return { oldAt, freshAt };
};

const countWhereCreatedAt = async (createdAt: number) => {
  const [loginRows, activityRows] = await Promise.all([
    tdb.select().from(logins).where(eq(logins.createdAt, createdAt)),
    tdb.select().from(activityLog).where(eq(activityLog.createdAt, createdAt))
  ]);
  return { logins: loginRows.length, activityLog: activityRows.length };
};

describe('log retention cron', () => {
  test('removes rows older than the retention window and keeps newer ones', async () => {
    const { oldAt, freshAt } = await seedRows({ old: 3, fresh: 2 });

    const result = await pruneExpiredLogs(90);

    expect(result).toEqual({ logins: 3, activityLog: 3 });
    expect(await countWhereCreatedAt(oldAt)).toEqual({
      logins: 0,
      activityLog: 0
    });
    expect(await countWhereCreatedAt(freshAt)).toEqual({
      logins: 2,
      activityLog: 2
    });
  });

  test('retentionDays 0 disables pruning', async () => {
    const { oldAt } = await seedRows({ old: 2, fresh: 1 });

    const result = await pruneExpiredLogs(0);

    expect(result).toEqual({ logins: 0, activityLog: 0 });
    expect(await countWhereCreatedAt(oldAt)).toEqual({
      logins: 2,
      activityLog: 2
    });
  });

  test('a negative or non-finite window is treated as disabled', async () => {
    const { oldAt } = await seedRows({ old: 1, fresh: 0 });

    expect(await pruneExpiredLogs(-1)).toEqual({ logins: 0, activityLog: 0 });
    expect(await pruneExpiredLogs(Number.NaN)).toEqual({
      logins: 0,
      activityLog: 0
    });
    expect(await countWhereCreatedAt(oldAt)).toEqual({
      logins: 1,
      activityLog: 1
    });
  });

  test('a backlog larger than one batch is drained completely', async () => {
    // 2 500 expired rows per table: three DELETE batches of 1000/1000/500
    // on logins, same on activity_log. The loop must not stop after the
    // first full batch.
    const { oldAt, freshAt } = await seedRows({ old: 2500, fresh: 1 });

    const result = await pruneExpiredLogs(90);

    expect(result).toEqual({ logins: 2500, activityLog: 2500 });
    expect(await countWhereCreatedAt(oldAt)).toEqual({
      logins: 0,
      activityLog: 0
    });
    expect(await countWhereCreatedAt(freshAt)).toEqual({
      logins: 1,
      activityLog: 1
    });
  });

  test('a row exactly at the boundary is kept, one past it is removed', async () => {
    const userId = await anyUserId();
    const retentionDays = 30;
    // Both timestamps are taken before the cron computes its own cutoff,
    // so "at the boundary" is strictly newer than the cron's cutoff and
    // "past it" is strictly older.
    const atBoundary = Date.now() - retentionDays * DAY_MS + 60_000;
    const pastBoundary = Date.now() - retentionDays * DAY_MS - 60_000;

    await tdb.insert(logins).values([
      { userId, ip: '127.0.0.1', createdAt: atBoundary },
      { userId, ip: '127.0.0.1', createdAt: pastBoundary }
    ]);

    const result = await pruneExpiredLogs(retentionDays);

    expect(result.logins).toBe(1);
    expect(await countWhereCreatedAt(atBoundary)).toMatchObject({ logins: 1 });
    expect(await countWhereCreatedAt(pastBoundary)).toMatchObject({
      logins: 0
    });
  });
});
