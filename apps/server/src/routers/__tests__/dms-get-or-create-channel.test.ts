import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { pairKeyFor } from '../../db/queries/dms';
import { dmChannelMembers, dmChannels } from '../../db/schema';

const pairChannels = async (a: number, b: number) =>
  getTestDb()
    .select({ id: dmChannels.id, pairKey: dmChannels.pairKey })
    .from(dmChannels)
    .where(eq(dmChannels.pairKey, await pairKeyFor(a, b)));

describe('dms.getOrCreateChannel pair key', () => {
  test('creates the channel under its pair key and returns it on repeat', async () => {
    const { caller } = await initTest(1);
    const { caller: other } = await initTest(2);

    const created = await caller.dms.getOrCreateChannel({ userId: 2 });
    expect(created.isGroup).toBe(false);
    expect(created.members.map((m) => m.id).sort()).toEqual([1, 2]);

    const rows = await pairChannels(1, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(created.id);

    // Either side asking again gets the same channel.
    expect((await caller.dms.getOrCreateChannel({ userId: 2 })).id).toBe(created.id);
    expect((await other.dms.getOrCreateChannel({ userId: 1 })).id).toBe(created.id);
    expect(await pairChannels(1, 2)).toHaveLength(1);
  });

  test('both sides creating at once share one channel', async () => {
    const { caller } = await initTest(1);
    const { caller: other } = await initTest(2);

    const results = await Promise.all([
      caller.dms.getOrCreateChannel({ userId: 2 }),
      other.dms.getOrCreateChannel({ userId: 1 }),
      caller.dms.getOrCreateChannel({ userId: 2 }),
      other.dms.getOrCreateChannel({ userId: 1 })
    ]);

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await pairChannels(1, 2)).toHaveLength(1);
  });

  test('adopts a channel that predates the pair key', async () => {
    const { caller } = await initTest(1);
    await initTest(2);
    const tdb = getTestDb();
    const now = Date.now();
    const [legacy] = await tdb
      .insert(dmChannels)
      .values({ isGroup: false, createdAt: now })
      .returning({ id: dmChannels.id });
    await tdb.insert(dmChannelMembers).values([
      { dmChannelId: legacy!.id, userId: 1, createdAt: now },
      { dmChannelId: legacy!.id, userId: 2, createdAt: now }
    ]);

    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });
    expect(channel.id).toBe(legacy!.id);
    expect((await pairChannels(1, 2))[0]!.id).toBe(legacy!.id);
  });
});
