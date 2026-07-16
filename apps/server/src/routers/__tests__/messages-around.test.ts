import { ChannelType } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { channels, messages } from '../../db/schema';

/**
 * Jump-to-message pagination: `aroundId` (window centered on a message)
 * and `after` (forward paging toward the present). Added for the
 * Discord-style message-link jump — the client around-fetches a window
 * when the target is outside loaded history, then fills forward.
 *
 * Rows are inserted directly with explicit createdAt values: the cursor
 * is timestamp-based, so deterministic spacing matters more than going
 * through messages.send (which stamps Date.now() and can collide).
 */

const createEmptyTextChannel = async (name: string) => {
  const [channel] = await getTestDb()
    .insert(channels)
    .values({
      type: ChannelType.TEXT,
      name,
      position: 50,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      publicId: randomUUIDv7(),
      categoryId: 1,
      serverId: 1,
      createdAt: Date.now()
    })
    .returning();

  return channel!;
};

/** Insert `count` messages spaced 1s apart; returns rows oldest-first. */
const seedMessages = async (channelId: number, count: number) => {
  const base = Date.now() - count * 1000;
  const rows = Array.from({ length: count }, (_, i) => ({
    content: `seed ${i}`,
    userId: 1,
    channelId,
    createdAt: base + i * 1000
  }));
  return getTestDb().insert(messages).values(rows).returning();
};

describe('messages.get around/after cursors', () => {
  test('aroundId returns a window spanning both sides of the anchor', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('around-window');
    const rows = await seedMessages(channel.id, 30);
    const anchor = rows[14]!; // middle

    const res = await caller.messages.get({
      channelId: channel.id,
      aroundId: anchor.id,
      limit: 10
    });

    const ids = res.messages.map((m) => m.id);
    expect(ids).toContain(anchor.id);

    // Both sides of the anchor are present (5 older incl. anchor + 5 newer).
    const older = res.messages.filter((m) => m.createdAt < anchor.createdAt);
    const newer = res.messages.filter((m) => m.createdAt > anchor.createdAt);
    expect(older.length).toBeGreaterThanOrEqual(1);
    expect(newer.length).toBeGreaterThanOrEqual(1);

    // History continues in both directions from the middle of the seed.
    expect(res.nextCursor).not.toBeNull();
    expect(res.afterCursor).not.toBeNull();

    // Response stays newest-first like the plain cursor pages.
    const sorted = [...res.messages].sort((a, b) => b.createdAt - a.createdAt);
    expect(res.messages.map((m) => m.id)).toEqual(sorted.map((m) => m.id));
  });

  test('after pages forward and reaches the tail (afterCursor null)', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('after-paging');
    const rows = await seedMessages(channel.id, 25);
    const anchor = rows[4]!; // near the oldest end

    const first = await caller.messages.get({
      channelId: channel.id,
      aroundId: anchor.id,
      limit: 10
    });
    expect(first.afterCursor).not.toBeNull();

    // Walk forward until attached to the tail, collecting everything.
    const seen = new Set(first.messages.map((m) => m.id));
    let after = first.afterCursor;
    let hops = 0;
    while (after !== null && hops < 10) {
      const page = await caller.messages.get({
        channelId: channel.id,
        after,
        limit: 10
      });
      for (const m of page.messages) seen.add(m.id);
      after = page.afterCursor;
      hops++;
    }

    expect(after).toBeNull();
    // Every message from the anchor to the newest is now loaded.
    const newestId = rows[rows.length - 1]!.id;
    expect(seen.has(newestId)).toBe(true);
    for (const row of rows.slice(4)) {
      expect(seen.has(row.id)).toBe(true);
    }
  });

  test('around the newest message reports an attached tail', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('around-tail');
    const rows = await seedMessages(channel.id, 12);
    const newest = rows[rows.length - 1]!;

    const res = await caller.messages.get({
      channelId: channel.id,
      aroundId: newest.id,
      limit: 10
    });

    expect(res.messages.map((m) => m.id)).toContain(newest.id);
    expect(res.afterCursor).toBeNull();
  });

  test('aroundId rejects a message from a different channel', async () => {
    const { caller } = await initTest(1);
    const channelA = await createEmptyTextChannel('around-a');
    const channelB = await createEmptyTextChannel('around-b');
    const rows = await seedMessages(channelA.id, 3);

    await expect(
      caller.messages.get({
        channelId: channelB.id,
        aroundId: rows[0]!.id,
        limit: 10
      })
    ).rejects.toThrow('Message not found');
  });

  test('plain cursor paging is unchanged (regression)', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('plain-cursor');
    await seedMessages(channel.id, 15);

    const first = await caller.messages.get({
      channelId: channel.id,
      cursor: null,
      limit: 10
    });
    expect(first.messages.length).toBe(10);
    expect(first.nextCursor).not.toBeNull();
    expect(first.afterCursor).toBeNull();

    const second = await caller.messages.get({
      channelId: channel.id,
      cursor: first.nextCursor,
      limit: 10
    });
    expect(second.messages.length).toBe(5);
    expect(second.nextCursor).toBeNull();
  });
});
