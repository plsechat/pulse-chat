import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createEmptyTextChannel } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { dmMessages, messages } from '../../db/schema';
import { purgeExpiredTombstones } from '../tombstones';

/**
 * The tombstone sweep, driven by its tick with an injected `now`: only
 * tombstones older than the window go; younger tombstones and live rows
 * (deleted_at NULL) stay; 0 disables it.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const tdb = () => getTestDb();

const insertMessage = async (channelId: number, deletedAt: number | null) => {
  const [row] = await tdb()
    .insert(messages)
    .values({
      content: deletedAt === null ? 'live' : null,
      userId: 1,
      channelId,
      createdAt: deletedAt ?? Date.now(),
      deletedAt,
      deletedBy: deletedAt === null ? null : 1
    })
    .returning({ id: messages.id });
  return row!.id;
};

const insertDmMessage = async (dmChannelId: number, deletedAt: number | null) => {
  const [row] = await tdb()
    .insert(dmMessages)
    .values({
      content: deletedAt === null ? 'live' : null,
      userId: 1,
      dmChannelId,
      createdAt: deletedAt ?? Date.now(),
      deletedAt,
      deletedBy: deletedAt === null ? null : 1
    })
    .returning({ id: dmMessages.id });
  return row!.id;
};

const messageExists = async (id: number) =>
  (await tdb().select({ id: messages.id }).from(messages).where(eq(messages.id, id))).length === 1;
const dmMessageExists = async (id: number) =>
  (await tdb().select({ id: dmMessages.id }).from(dmMessages).where(eq(dmMessages.id, id))).length === 1;

describe('purgeExpiredTombstones', () => {
  test('removes tombstones older than the window on both tables and keeps the rest', async () => {
    const { caller } = await initTest(1);
    await initTest(2);
    const channel = await createEmptyTextChannel('sweep');
    const dm = await caller.dms.getOrCreateChannel({ userId: 2 });
    const now = Date.now();

    const live = await insertMessage(channel.id, null);
    const old = await insertMessage(channel.id, now - 31 * DAY_MS);
    const young = await insertMessage(channel.id, now - 29 * DAY_MS);
    const dmLive = await insertDmMessage(dm.id, null);
    const dmOld = await insertDmMessage(dm.id, now - 40 * DAY_MS);
    const dmYoung = await insertDmMessage(dm.id, now - 2 * DAY_MS);

    // A reply to the old tombstone: its FK goes null, the reply stays.
    const [reply] = await tdb()
      .insert(messages)
      .values({ content: 're', userId: 1, channelId: channel.id, replyToId: old, createdAt: now })
      .returning({ id: messages.id });

    expect(await purgeExpiredTombstones(now, 30)).toEqual({ messages: 1, dmMessages: 1 });
    expect(await messageExists(live)).toBe(true);
    expect(await messageExists(old)).toBe(false);
    expect(await messageExists(young)).toBe(true);
    expect(await dmMessageExists(dmLive)).toBe(true);
    expect(await dmMessageExists(dmOld)).toBe(false);
    expect(await dmMessageExists(dmYoung)).toBe(true);
    const [replyRow] = await tdb().select().from(messages).where(eq(messages.id, reply!.id));
    expect(replyRow!.replyToId).toBeNull();

    // Time moves on: the young ones age into the window.
    expect(await purgeExpiredTombstones(now + 2 * DAY_MS, 30)).toEqual({ messages: 1, dmMessages: 0 });
    expect(await messageExists(young)).toBe(false);
    expect(await dmMessageExists(dmYoung)).toBe(true);
  });

  test('0 (and a negative or non-finite window) keeps every tombstone', async () => {
    await initTest(1);
    const channel = await createEmptyTextChannel('sweep-off');
    const now = Date.now();
    const old = await insertMessage(channel.id, now - 400 * DAY_MS);

    expect(await purgeExpiredTombstones(now, 0)).toEqual({ messages: 0, dmMessages: 0 });
    expect(await purgeExpiredTombstones(now, -1)).toEqual({ messages: 0, dmMessages: 0 });
    expect(await purgeExpiredTombstones(now, Number.NaN)).toEqual({ messages: 0, dmMessages: 0 });
    expect(await messageExists(old)).toBe(true);
  });

  test('a backlog larger than one batch is drained completely', async () => {
    await initTest(1);
    const channel = await createEmptyTextChannel('sweep-batch');
    const now = Date.now();
    const oldAt = now - 60 * DAY_MS;

    // 1 500 expired tombstones: two DELETE batches of 1000 + 500.
    await tdb()
      .insert(messages)
      .values(
        Array.from({ length: 1500 }, () => ({
          content: null,
          userId: 1,
          channelId: channel.id,
          createdAt: oldAt,
          deletedAt: oldAt,
          deletedBy: 1
        }))
      );
    const keep = await insertMessage(channel.id, null);

    expect(await purgeExpiredTombstones(now, 30)).toEqual({ messages: 1500, dmMessages: 0 });
    expect(
      await tdb().select({ id: messages.id }).from(messages).where(eq(messages.channelId, channel.id))
    ).toHaveLength(1);
    expect(await messageExists(keep)).toBe(true);
  });
});
