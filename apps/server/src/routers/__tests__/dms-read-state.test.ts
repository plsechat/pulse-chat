import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';
import {
  dmChannelMembers,
  dmChannels,
  dmMessages,
  dmReadStates
} from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

// DM read-state writes must publish DM_READ_STATE_UPDATE to the reader
// (self-scoped) exactly once per written row, so the reader's other
// devices drop the badge without refetching channels.

type PublishCall = [unknown, string, unknown];

const readStatePublishes = (spy: { mock: { calls: readonly unknown[] } }) =>
  (spy.mock.calls as PublishCall[])
    .filter(([, topic]) => topic === ServerEvents.DM_READ_STATE_UPDATE)
    .map(([userIds, , payload]) => ({
      userIds,
      payload: payload as { dmChannelId: number; lastReadMessageId: number }
    }));

const readMarker = async (userId: number, dmChannelId: number) => {
  const [row] = await getTestDb()
    .select({ lastReadMessageId: dmReadStates.lastReadMessageId })
    .from(dmReadStates)
    .where(
      and(
        eq(dmReadStates.userId, userId),
        eq(dmReadStates.dmChannelId, dmChannelId)
      )
    )
    .limit(1);
  return row?.lastReadMessageId ?? null;
};

const insertEmptyGroup = async (memberIds: number[]) => {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(dmChannels)
    .values({ ownerId: memberIds[0], isGroup: true, createdAt: now })
    .returning();
  await tdb.insert(dmChannelMembers).values(
    memberIds.map((userId) => ({ dmChannelId: row!.id, userId, createdAt: now }))
  );
  return row!.id;
};

describe('dms.markChannelAsRead', () => {
  afterEach(() => mock.restore());

  test('writes the newest id and publishes once to the reader only', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const first = await caller2.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'one'
    });
    const second = await caller2.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'two'
    });
    expect(second).toBeGreaterThan(first);

    const spy = spyOn(pubsub, 'publishFor');
    await caller1.dms.markChannelAsRead({ dmChannelId: channel.id });

    const published = readStatePublishes(spy);
    expect(published).toHaveLength(1);
    expect(published[0]!.userIds).toBe(1);
    expect(published[0]!.payload).toEqual({
      dmChannelId: channel.id,
      lastReadMessageId: second
    });
    expect(await readMarker(1, channel.id)).toBe(second);

    const channels = await caller1.dms.getChannels();
    expect(channels.find((c) => c.id === channel.id)!.unreadCount).toBe(0);
  });

  test('empty channel: no row, no publish', async () => {
    const { caller: caller1 } = await initTest(1);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    const spy = spyOn(pubsub, 'publishFor');
    await caller1.dms.markChannelAsRead({ dmChannelId: channel.id });

    expect(readStatePublishes(spy)).toHaveLength(0);
    expect(await readMarker(1, channel.id)).toBeNull();
  });

  test('non-member is refused and nothing is written', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller3 } = await initTest(3);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await caller1.dms.sendMessage({ dmChannelId: channel.id, content: 'x' });

    await expect(
      caller3.dms.markChannelAsRead({ dmChannelId: channel.id })
    ).rejects.toThrow('You are not a member of this DM channel');
    expect(await readMarker(3, channel.id)).toBeNull();
  });

  test('rejects a non-integer channel id', async () => {
    const { caller: caller1 } = await initTest(1);
    await expect(
      caller1.dms.markChannelAsRead({ dmChannelId: 1.5 })
    ).rejects.toThrow();
  });
});

describe('dms.markAllAsRead', () => {
  afterEach(() => mock.restore());

  test('one upsert per channel with messages, one publish each, only own channels', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);

    // A: 1↔2 with unread (marker at m1, then two more arrive).
    const a = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await caller2.dms.sendMessage({ dmChannelId: a.id, content: 'a1' });
    await caller1.dms.markChannelAsRead({ dmChannelId: a.id });
    await caller2.dms.sendMessage({ dmChannelId: a.id, content: 'a2' });
    const a3 = await caller2.dms.sendMessage({
      dmChannelId: a.id,
      content: 'a3'
    });

    // B: 1↔3 with one unread, no prior read row.
    const b = await caller1.dms.getOrCreateChannel({ userId: 3 });
    const b1 = await caller3.dms.sendMessage({
      dmChannelId: b.id,
      content: 'b1'
    });

    // C: group with no messages — nothing to mark.
    const c = await insertEmptyGroup([1, 2, 3]);

    // D: 2↔3, user 1 is not a member — must not get a row.
    const d = await caller2.dms.getOrCreateChannel({ userId: 3 });
    await caller3.dms.sendMessage({ dmChannelId: d.id, content: 'd1' });

    const before = await caller1.dms.getChannels();
    expect(before.find((ch) => ch.id === a.id)!.unreadCount).toBe(2);

    const spy = spyOn(pubsub, 'publishFor');
    await caller1.dms.markAllAsRead();

    const published = readStatePublishes(spy);
    expect(published).toHaveLength(2);
    for (const p of published) expect(p.userIds).toBe(1);
    const byChannel = new Map(
      published.map((p) => [p.payload.dmChannelId, p.payload.lastReadMessageId])
    );
    expect(byChannel.get(a.id)).toBe(a3);
    expect(byChannel.get(b.id)).toBe(b1);

    expect(await readMarker(1, a.id)).toBe(a3);
    expect(await readMarker(1, b.id)).toBe(b1);
    expect(await readMarker(1, c)).toBeNull();
    expect(await readMarker(1, d.id)).toBeNull();

    const after = await caller1.dms.getChannels();
    for (const ch of after) expect(ch.unreadCount).toBe(0);
  });
});

describe('dms.getMessages read-state write', () => {
  afterEach(() => mock.restore());

  test('first page publishes once; paging back neither publishes nor moves the marker', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(
        await caller2.dms.sendMessage({
          dmChannelId: channel.id,
          content: `m${i}`
        })
      );
    }
    const newest = Math.max(...ids);

    const spy = spyOn(pubsub, 'publishFor');
    const page1 = await caller1.dms.getMessages({
      dmChannelId: channel.id,
      limit: 2
    });
    expect(page1.messages).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();

    let published = readStatePublishes(spy);
    expect(published).toHaveLength(1);
    expect(published[0]!.payload).toEqual({
      dmChannelId: channel.id,
      lastReadMessageId: newest
    });
    expect(await readMarker(1, channel.id)).toBe(newest);

    const page2 = await caller1.dms.getMessages({
      dmChannelId: channel.id,
      cursor: page1.nextCursor!,
      limit: 2
    });
    expect(page2.messages).toHaveLength(1);

    published = readStatePublishes(spy);
    expect(published).toHaveLength(1);
    expect(await readMarker(1, channel.id)).toBe(newest);
  });

  test('marker never regresses below a higher id', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const tdb = getTestDb();
    const now = Date.now();

    // Higher id but older createdAt: the newest-by-time first page
    // (limit 1) carries a LOWER id than the current marker.
    const [newerByTime] = await tdb
      .insert(dmMessages)
      .values({ dmChannelId: channel.id, userId: 2, content: 'x', createdAt: now })
      .returning();
    const [higherId] = await tdb
      .insert(dmMessages)
      .values({
        dmChannelId: channel.id,
        userId: 2,
        content: 'y',
        createdAt: now - 60_000
      })
      .returning();
    expect(higherId!.id).toBeGreaterThan(newerByTime!.id);

    await caller1.dms.markChannelAsRead({ dmChannelId: channel.id });
    expect(await readMarker(1, channel.id)).toBe(higherId!.id);

    const spy = spyOn(pubsub, 'publishFor');
    const page = await caller1.dms.getMessages({
      dmChannelId: channel.id,
      limit: 1
    });
    expect(page.messages[0]!.id).toBe(newerByTime!.id);

    expect(await readMarker(1, channel.id)).toBe(higherId!.id);
    const published = readStatePublishes(spy);
    expect(published).toHaveLength(1);
    expect(published[0]!.payload.lastReadMessageId).toBe(higherId!.id);
  });

  test('bounds: limit 1..100, integer cursor', async () => {
    const { caller: caller1 } = await initTest(1);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    await expect(
      caller1.dms.getMessages({ dmChannelId: channel.id, limit: 101 })
    ).rejects.toThrow();
    await expect(
      caller1.dms.getMessages({ dmChannelId: channel.id, limit: 0 })
    ).rejects.toThrow();
    await expect(
      caller1.dms.getMessages({ dmChannelId: channel.id, cursor: 1.5 })
    ).rejects.toThrow();
    await expect(
      caller1.dms.getMessages({ dmChannelId: channel.id, limit: 100 })
    ).resolves.toBeDefined();
  });
});
