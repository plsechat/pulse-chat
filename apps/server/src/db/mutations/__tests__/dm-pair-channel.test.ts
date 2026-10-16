import { describe, expect, test } from 'bun:test';
import { and, eq, isNull, sql } from 'drizzle-orm';
import path from 'node:path';
import { PEER_DOMAIN, seedPeerInstance } from '../../../__tests__/federation-fixtures';
import { createTestUser } from '../../../__tests__/fixtures';
import { getTestDb } from '../../../__tests__/mock-db';
import { findDmChannelBetween, pairKeyFor } from '../../queries/dms';
import {
  dmChannelMembers,
  dmChannels,
  dmMessages,
  dmReadStates,
  users
} from '../../schema';
import { getOrCreatePairChannel } from '../dms';
import { findOrCreateShadowUserByPublicId } from '../federation';

const publicIdOf = async (userId: number): Promise<string> => {
  const [row] = await getTestDb()
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, userId));
  return row!.publicId;
};

/** A 1:1 channel inserted the way code predating the pair key did. */
const seedLegacyPair = async (
  a: number,
  b: number,
  opts?: { e2ee?: boolean }
): Promise<number> => {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(dmChannels)
    .values({ isGroup: false, e2ee: opts?.e2ee ?? false, createdAt: now })
    .returning({ id: dmChannels.id });
  await tdb.insert(dmChannelMembers).values([
    { dmChannelId: row!.id, userId: a, createdAt: now },
    { dmChannelId: row!.id, userId: b, createdAt: now }
  ]);
  return row!.id;
};

const channelRow = async (id: number) => {
  const [row] = await getTestDb()
    .select({ id: dmChannels.id, pairKey: dmChannels.pairKey, e2ee: dmChannels.e2ee })
    .from(dmChannels)
    .where(eq(dmChannels.id, id));
  return row;
};

const memberIds = async (channelId: number): Promise<number[]> =>
  (
    await getTestDb()
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, channelId))
  )
    .map((r) => r.userId)
    .sort((x, y) => x - y);

describe('pairKeyFor', () => {
  test('two locals: sorted local identities, order-independent', async () => {
    const [p1, p2] = await Promise.all([publicIdOf(1), publicIdOf(2)]);
    const expected = [`local:${p1}`, `local:${p2}`].sort().join('|');

    expect(await pairKeyFor(1, 2)).toBe(expected);
    expect(await pairKeyFor(2, 1)).toBe(expected);
  });

  test('a shadow is named by its home instance and the publicId that home issued', async () => {
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    const shadow = await findOrCreateShadowUserByPublicId(instanceId, 'remote-pid', 'Remote');
    const p1 = await publicIdOf(1);

    const key = await pairKeyFor(1, shadow.id);
    expect(key.split('|').sort()).toEqual(
      [`local:${p1}`, `federated:${PEER_DOMAIN}:remote-pid`].sort()
    );
    // The shadow's own local publicId plays no part — both instances must
    // be able to compute the same identity for the same remote user.
    expect(key).not.toContain(shadow.publicId);
  });

  test('refuses a self-pair and unknown users', async () => {
    await expect(pairKeyFor(1, 1)).rejects.toThrow();
    await expect(pairKeyFor(1, 999_999)).rejects.toThrow();
  });
});

describe('findDmChannelBetween', () => {
  test('null when the pair has no channel', async () => {
    expect(await findDmChannelBetween(1, 2)).toBeNull();
  });

  test('adopts a channel that predates the pair key and stamps it', async () => {
    const legacy = await seedLegacyPair(1, 2);
    expect((await channelRow(legacy))!.pairKey).toBeNull();

    expect(await findDmChannelBetween(2, 1)).toBe(legacy);
    expect((await channelRow(legacy))!.pairKey).toBe(await pairKeyFor(1, 2));

    // Stamped, so the indexed path finds it now.
    expect(await findDmChannelBetween(1, 2)).toBe(legacy);
  });

  test('never adopts a group channel or a channel of another pair', async () => {
    const third = await createTestUser();
    await seedLegacyPair(1, third);
    const tdb = getTestDb();
    const now = Date.now();
    const [group] = await tdb
      .insert(dmChannels)
      .values({ isGroup: true, createdAt: now })
      .returning({ id: dmChannels.id });
    await tdb.insert(dmChannelMembers).values([
      { dmChannelId: group!.id, userId: 1, createdAt: now },
      { dmChannelId: group!.id, userId: 2, createdAt: now }
    ]);

    expect(await findDmChannelBetween(1, 2)).toBeNull();
    expect((await channelRow(group!.id))!.pairKey).toBeNull();
  });
});

describe('getOrCreatePairChannel', () => {
  test('creates once, then returns the same channel', async () => {
    const first = await getOrCreatePairChannel(1, 2, { e2ee: true });
    expect(first.created).toBe(true);
    expect(await memberIds(first.id)).toEqual([1, 2]);

    const again = await getOrCreatePairChannel(2, 1, { e2ee: false });
    expect(again).toEqual({ id: first.id, created: false });
    // e2ee is a creation-time option only.
    expect((await channelRow(first.id))!.e2ee).toBe(true);
    expect((await channelRow(first.id))!.pairKey).toBe(await pairKeyFor(1, 2));
  });

  test('concurrent first contact yields exactly one channel', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        getOrCreatePairChannel(i % 2 ? 1 : 2, i % 2 ? 2 : 1)
      )
    );

    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);

    const rows = await getTestDb()
      .select({ id: dmChannels.id })
      .from(dmChannels)
      .where(eq(dmChannels.pairKey, await pairKeyFor(1, 2)));
    expect(rows).toHaveLength(1);
    expect(await memberIds(rows[0]!.id)).toEqual([1, 2]);
  });

  test('adopts a legacy channel instead of minting beside it', async () => {
    const legacy = await seedLegacyPair(1, 2);
    const result = await getOrCreatePairChannel(1, 2);
    expect(result).toEqual({ id: legacy, created: false });
  });

  test('completes a creation whose member rows never landed', async () => {
    const pairKey = await pairKeyFor(1, 2);
    const [half] = await getTestDb()
      .insert(dmChannels)
      .values({ isGroup: false, pairKey, createdAt: Date.now() })
      .returning({ id: dmChannels.id });

    const result = await getOrCreatePairChannel(1, 2);
    expect(result).toEqual({ id: half!.id, created: false });
    expect(await memberIds(half!.id)).toEqual([1, 2]);
  });
});

describe('migration 0036 pair_key backfill', () => {
  const backfillSql = async (): Promise<string> => {
    const file = path.resolve(
      import.meta.dirname,
      '../../migrations/0036_b5_federation.sql'
    );
    const text = await Bun.file(file).text();
    const marker = '-- dm_channels.pair_key backfill';
    const at = text.indexOf(marker);
    if (at < 0) throw new Error('backfill marker missing from 0036');
    return text.slice(at);
  };

  const runBackfill = async () => {
    await getTestDb().execute(sql.raw(await backfillSql()));
  };

  test('stamps keys, merges duplicate pairs into the lowest id, and replays as a no-op', async () => {
    const tdb = getTestDb();
    const now = Date.now();
    const third = await createTestUser();
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    const shadow = await findOrCreateShadowUserByPublicId(instanceId, 'remote-pid', 'Remote');

    // Three channels for the (1,2) pair — racing first contacts.
    const keep = await seedLegacyPair(1, 2);
    const dupeA = await seedLegacyPair(2, 1, { e2ee: true });
    const dupeB = await seedLegacyPair(1, 2);
    // One clean pair, one federated pair, one group: stamped / stamped / untouched.
    const other = await seedLegacyPair(1, third);
    const federated = await seedLegacyPair(2, shadow.id);
    const [group] = await tdb
      .insert(dmChannels)
      .values({ isGroup: true, createdAt: now })
      .returning({ id: dmChannels.id });
    await tdb.insert(dmChannelMembers).values([
      { dmChannelId: group!.id, userId: 1, createdAt: now },
      { dmChannelId: group!.id, userId: 2, createdAt: now }
    ]);

    const msg = async (channelId: number, userId: number, content: string) => {
      const [m] = await tdb
        .insert(dmMessages)
        .values({ dmChannelId: channelId, userId, content, createdAt: now })
        .returning({ id: dmMessages.id });
      return m!.id;
    };
    const m1 = await msg(keep, 1, 'in keeper');
    const m2 = await msg(dupeA, 2, 'in dupe A');
    const m3 = await msg(dupeB, 1, 'in dupe B');
    const mOther = await msg(other, third, 'elsewhere');

    // Read states: user 1 has one on the keeper (older) and on dupe B
    // (newer); user 2 only on dupe A — merged, not lost.
    await tdb.insert(dmReadStates).values([
      { userId: 1, dmChannelId: keep, lastReadMessageId: m1, lastReadAt: now - 1000 },
      { userId: 1, dmChannelId: dupeB, lastReadMessageId: m3, lastReadAt: now },
      { userId: 2, dmChannelId: dupeA, lastReadMessageId: m2, lastReadAt: now }
    ]);

    await runBackfill();

    // One channel for the pair: the lowest id, carrying the key.
    const pairRows = await tdb
      .select({ id: dmChannels.id, pairKey: dmChannels.pairKey })
      .from(dmChannels)
      .where(eq(dmChannels.pairKey, await pairKeyFor(1, 2)));
    expect(pairRows.map((r) => r.id)).toEqual([keep]);
    expect(await channelRow(dupeA)).toBeUndefined();
    expect(await channelRow(dupeB)).toBeUndefined();

    // Every message of the pair lives in the keeper now.
    const moved = await tdb
      .select({ id: dmMessages.id })
      .from(dmMessages)
      .where(eq(dmMessages.dmChannelId, keep));
    expect(moved.map((r) => r.id).sort((x, y) => x - y)).toEqual([m1, m2, m3]);
    const [stray] = await tdb
      .select({ id: dmMessages.id })
      .from(dmMessages)
      .where(eq(dmMessages.id, mOther));
    expect(stray!.id).toBe(mOther);

    // Read states merged onto the keeper with the furthest position.
    const states = await tdb
      .select()
      .from(dmReadStates)
      .where(eq(dmReadStates.dmChannelId, keep))
      .orderBy(dmReadStates.userId);
    expect(states.map((s) => [s.userId, s.lastReadMessageId, s.lastReadAt])).toEqual([
      [1, m3, now],
      [2, m2, now]
    ]);

    // The other pairs are stamped with their own keys; the group is not.
    expect((await channelRow(other))!.pairKey).toBe(await pairKeyFor(1, third));
    expect((await channelRow(federated))!.pairKey).toBe(await pairKeyFor(2, shadow.id));
    expect((await channelRow(federated))!.pairKey).toContain(
      `federated:${PEER_DOMAIN}:remote-pid`
    );
    expect((await channelRow(group!.id))!.pairKey).toBeNull();

    // Replay: nothing left to stamp, nothing merged, nothing lost.
    await runBackfill();
    const unstamped = await tdb
      .select({ id: dmChannels.id })
      .from(dmChannels)
      .where(and(eq(dmChannels.isGroup, false), isNull(dmChannels.pairKey)));
    expect(unstamped).toHaveLength(0);
    expect(
      (await tdb.select({ id: dmMessages.id }).from(dmMessages)).length
    ).toBe(4);
    expect(await findDmChannelBetween(1, 2)).toBe(keep);
  });

  test('the SQL sort and the application sort agree on the key', async () => {
    // Identities whose order differs between a locale collation and
    // code-unit order: '-' sorts before letters in "C", after in most
    // locales once punctuation is weighed.
    const tdb = getTestDb();
    const a = await createTestUser();
    const b = await createTestUser();
    await tdb.update(users).set({ publicId: 'abc-z' }).where(eq(users.id, a));
    await tdb.update(users).set({ publicId: 'abcd' }).where(eq(users.id, b));
    const legacy = await seedLegacyPair(a, b);

    await runBackfill();

    expect((await channelRow(legacy))!.pairKey).toBe(await pairKeyFor(a, b));
    expect((await channelRow(legacy))!.pairKey).toBe('local:abc-z|local:abcd');
  });
});
