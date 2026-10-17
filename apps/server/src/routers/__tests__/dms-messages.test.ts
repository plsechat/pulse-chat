import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';
import {
  dmMessageFiles,
  dmMessageReactions,
  dmMessages,
  dmReadStates,
  files
} from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

const insertFileRow = async (userId: number, name: string) => {
  const [row] = await getTestDb()
    .insert(files)
    .values({
      name,
      originalName: name,
      md5: `md5-${name}`,
      userId,
      size: 3,
      mimeType: 'text/plain',
      extension: '.txt',
      createdAt: Date.now()
    })
    .returning({ id: files.id });
  return row!.id;
};

describe('dms reply scope (replyToId)', () => {
  test('send refuses a reply target from another conversation', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    const a = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const b = await caller1.dms.getOrCreateChannel({ userId: 3 });
    const secret = await caller1.dms.sendMessage({
      dmChannelId: b.id,
      content: 'only for channel B'
    });

    await expect(
      caller1.dms.sendMessage({
        dmChannelId: a.id,
        content: 'leak?',
        replyToId: secret
      })
    ).rejects.toThrow('Reply target is not in this conversation');
    await expect(
      caller1.dms.sendMessage({
        dmChannelId: a.id,
        content: 'leak?',
        replyToId: 999_999
      })
    ).rejects.toThrow('Reply target is not in this conversation');

    // Same-conversation reply still works and carries the preview.
    const own = await caller1.dms.sendMessage({
      dmChannelId: a.id,
      content: 'parent'
    });
    const replyId = await caller1.dms.sendMessage({
      dmChannelId: a.id,
      content: 'child',
      replyToId: own
    });
    const page = await caller1.dms.getMessages({ dmChannelId: a.id });
    const reply = page.messages.find((m) => m.id === replyId)!;
    expect(reply.replyTo?.id).toBe(own);
    expect(reply.replyTo?.content).toBe('parent');
  });

  test('pre-existing cross-conversation rows preview as null in every reader', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    const a = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const b = await caller1.dms.getOrCreateChannel({ userId: 3 });
    const secret = await caller1.dms.sendMessage({
      dmChannelId: b.id,
      content: 'only for channel B'
    });

    const tdb = getTestDb();
    const [bad] = await tdb
      .insert(dmMessages)
      .values({
        dmChannelId: a.id,
        userId: 1,
        content: 'findme bad reply',
        replyToId: secret,
        createdAt: Date.now()
      })
      .returning();

    const page = await caller2.dms.getMessages({ dmChannelId: a.id });
    expect(page.messages.find((m) => m.id === bad!.id)!.replyTo).toBeNull();

    await caller2.dms.pinMessage({ dmMessageId: bad!.id });
    const pinned = await caller2.dms.getPinned({ dmChannelId: a.id });
    expect(pinned.find((m) => m.id === bad!.id)!.replyTo).toBeNull();

    const scoped = await caller2.dms.searchMessages({
      query: 'findme',
      dmChannelId: a.id
    });
    expect(scoped.messages[0]!.id).toBe(bad!.id);
    expect(scoped.messages[0]!.replyTo).toBeNull();

    const global = await caller2.dms.searchMessages({ query: 'findme' });
    expect(global.messages[0]!.replyTo).toBeNull();
  });
});

describe('dms.searchMessages hasFile', () => {
  test('returns only messages with attachments and keeps createdAt ordering', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const plain = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'attach plain'
    });
    const withFile = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'attach with file'
    });
    const fileId = await insertFileRow(1, `dm-search-${Date.now()}.txt`);
    await getTestDb().insert(dmMessageFiles).values({
      dmMessageId: withFile,
      fileId,
      createdAt: Date.now()
    });

    const filtered = await caller1.dms.searchMessages({
      query: 'attach',
      hasFile: true
    });
    expect(filtered.messages.map((m) => m.id)).toEqual([withFile]);
    expect(filtered.messages[0]!.files.map((f) => f.id)).toEqual([fileId]);

    const all = await caller1.dms.searchMessages({ query: 'attach' });
    expect(all.messages.map((m) => m.id).sort()).toEqual(
      [plain, withFile].sort()
    );
  });

  test('bounds on ids and cursor', async () => {
    const { caller: caller1 } = await initTest(1);
    await expect(
      caller1.dms.searchMessages({ query: 'x', dmChannelId: 0 })
    ).rejects.toThrow();
    await expect(
      caller1.dms.searchMessages({ query: 'x', cursor: 1.5 })
    ).rejects.toThrow();
    await expect(
      caller1.dms.searchMessages({ query: 'x', limit: 51 })
    ).rejects.toThrow();
  });
});

describe('dms.editMessage e2ee contract', () => {
  test('plaintext edit over an encrypted row is refused', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await caller1.dms.enableEncryption({ dmChannelId: channel.id });
    const messageId = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'ciphertext-envelope',
      e2ee: true
    });

    await expect(
      caller1.dms.editMessage({ messageId, content: 'plaintext', e2ee: false })
    ).rejects.toThrow('plaintext edits are not allowed');

    const [row] = await getTestDb()
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.id, messageId));
    expect(row!.content).toBe('ciphertext-envelope');
    expect(row!.e2ee).toBe(true);
    expect(row!.edited).toBe(false);
  });

  test('encrypted edit over a plaintext row is refused; the flag is required', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const messageId = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'hello'
    });

    await expect(
      caller1.dms.editMessage({ messageId, content: 'cipher', e2ee: true })
    ).rejects.toThrow('encrypted edits are not allowed');
    await expect(
      // @ts-expect-error — e2ee is required on the wire
      caller1.dms.editMessage({ messageId, content: 'cipher' })
    ).rejects.toThrow();
    await expect(
      caller1.dms.editMessage({ messageId, content: '', e2ee: false })
    ).rejects.toThrow();
  });

  test('matching flag edits the row, publishes to members, and refuses other authors', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const messageId = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'hello'
    });

    await expect(
      caller2.dms.editMessage({ messageId, content: 'hijack', e2ee: false })
    ).rejects.toThrow('You can only edit your own messages');

    const spy = spyOn(pubsub, 'publishFor');
    try {
      await caller1.dms.editMessage({
        messageId,
        content: 'hello edited',
        e2ee: false
      });
      const updates = spy.mock.calls.filter(
        ([, topic]) => topic === ServerEvents.DM_MESSAGE_UPDATE
      );
      expect(updates.map(([userIds]) => userIds).sort()).toEqual([1, 2]);
    } finally {
      mock.restore();
    }

    const page = await caller2.dms.getMessages({ dmChannelId: channel.id });
    const edited = page.messages.find((m) => m.id === messageId)!;
    expect(edited.content).toBe('hello edited');
    expect(edited.edited).toBe(true);
  });
});

describe('dms pins', () => {
  test('any member can pin/unpin; getPinned lists them; non-member refused', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const dmMessageId = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'pin me'
    });

    await expect(caller3.dms.pinMessage({ dmMessageId })).rejects.toThrow(
      'You are not a member of this DM channel'
    );
    await expect(
      caller3.dms.getPinned({ dmChannelId: channel.id })
    ).rejects.toThrow('You are not a member of this DM channel');

    await caller2.dms.pinMessage({ dmMessageId });
    await expect(caller2.dms.pinMessage({ dmMessageId })).rejects.toThrow(
      'Message is already pinned'
    );

    const pinned = await caller1.dms.getPinned({ dmChannelId: channel.id });
    expect(pinned.map((m) => m.id)).toEqual([dmMessageId]);
    expect(pinned[0]!.pinnedBy).toBe(2);

    await expect(caller3.dms.unpinMessage({ dmMessageId })).rejects.toThrow(
      'You are not a member of this DM channel'
    );
    await caller1.dms.unpinMessage({ dmMessageId });
    await expect(caller1.dms.unpinMessage({ dmMessageId })).rejects.toThrow(
      'Message is not pinned'
    );
    expect(await caller1.dms.getPinned({ dmChannelId: channel.id })).toEqual(
      []
    );

    await expect(caller1.dms.pinMessage({ dmMessageId: 0 })).rejects.toThrow();
    await expect(
      caller1.dms.pinMessage({ dmMessageId: 999_999 })
    ).rejects.toThrow('Message not found');
  });
});

describe('dms.deleteMessage', () => {
  afterEach(() => mock.restore());

  test('author deletes: the row stays as a tombstone (attachments gone, members notified); others refused', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const messageId = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'delete me'
    });
    const tdb = getTestDb();
    const fileId = await insertFileRow(1, `dm-delete-${Date.now()}.txt`);
    await tdb
      .insert(dmMessageFiles)
      .values({ dmMessageId: messageId, fileId, createdAt: Date.now() });

    await expect(caller2.dms.deleteMessage({ messageId })).rejects.toThrow(
      'You can only delete your own messages'
    );
    await expect(caller3.dms.deleteMessage({ messageId })).rejects.toThrow(
      'You can only delete your own messages'
    );

    await caller1.dms.toggleReaction({ dmMessageId: messageId, emoji: '👍' });
    await caller1.dms.pinMessage({ dmMessageId: messageId });

    const spy = spyOn(pubsub, 'publishFor');
    const before = Date.now();
    await caller1.dms.deleteMessage({ messageId });

    const [row] = await tdb.select().from(dmMessages).where(eq(dmMessages.id, messageId));
    expect(row).toMatchObject({ content: null, pinned: false, pinnedBy: null, deletedBy: 1 });
    expect(row!.deletedAt).toBeGreaterThanOrEqual(before);

    const deletes = spy.mock.calls.filter(
      ([, topic]) => topic === ServerEvents.DM_MESSAGE_DELETE
    );
    expect(deletes.map(([userIds]) => userIds).sort()).toEqual([1, 2]);
    expect(deletes[0]![2]).toEqual({
      dmMessageId: messageId,
      dmChannelId: channel.id,
      deletedAt: row!.deletedAt,
      deletedBy: 1
    });

    expect(
      await tdb.select().from(files).where(eq(files.id, fileId))
    ).toHaveLength(0);
    expect(
      await tdb.select().from(dmMessageReactions).where(eq(dmMessageReactions.dmMessageId, messageId))
    ).toHaveLength(0);

    // Listed in place as a tombstone; not pinned; not searchable.
    const { messages: listed } = await caller2.dms.getMessages({ dmChannelId: channel.id });
    expect(listed.find((m) => m.id === messageId)).toMatchObject({
      content: null,
      deletedBy: 1,
      files: [],
      reactions: []
    });
    expect(await caller2.dms.getPinned({ dmChannelId: channel.id })).toEqual([]);
    expect(
      (await caller2.dms.searchMessages({ query: 'delete me' })).messages
    ).toHaveLength(0);

    await expect(caller1.dms.deleteMessage({ messageId })).rejects.toThrow(
      'Message is already deleted'
    );
  });

  test('an encrypted message is tombstoned with its ciphertext cleared', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await caller1.dms.enableEncryption({ dmChannelId: channel.id });
    const messageId = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'ciphertext-envelope',
      e2ee: true
    });

    await caller1.dms.deleteMessage({ messageId });

    const [row] = await getTestDb().select().from(dmMessages).where(eq(dmMessages.id, messageId));
    expect(row).toMatchObject({ content: null, e2ee: true, deletedBy: 1 });
    expect(row!.deletedAt).toBeGreaterThan(0);
  });

  test('edit, react, pin, reply and forward on a tombstone are refused', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const messageId = await caller1.dms.sendMessage({ dmChannelId: channel.id, content: 'gone' });
    await caller1.dms.deleteMessage({ messageId });

    await expect(
      caller1.dms.editMessage({ messageId, content: 'back', e2ee: false })
    ).rejects.toThrow('This message was deleted');
    await expect(
      caller2.dms.toggleReaction({ dmMessageId: messageId, emoji: '👍' })
    ).rejects.toThrow('This message was deleted');
    await expect(caller2.dms.pinMessage({ dmMessageId: messageId })).rejects.toThrow(
      'This message was deleted'
    );
    await expect(
      caller2.dms.sendMessage({ dmChannelId: channel.id, content: 're', replyToId: messageId })
    ).rejects.toThrow('You cannot reply to a deleted message');
    await expect(
      caller2.dms.sendMessage({
        dmChannelId: channel.id,
        content: 'fwd',
        forwardedFrom: { sourceKind: 'dm', sourceId: messageId }
      })
    ).rejects.toThrow('Source message was deleted');
  });

  test('a tombstone is not unread; as the last message it is the channel\'s deleted snippet', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const first = await caller1.dms.sendMessage({ dmChannelId: channel.id, content: 'first' });
    // User 2 reads up to the first message, then two more arrive.
    await caller2.dms.getMessages({ dmChannelId: channel.id });
    await caller1.dms.sendMessage({ dmChannelId: channel.id, content: 'second' });
    const last = await caller1.dms.sendMessage({ dmChannelId: channel.id, content: 'third' });
    expect(last).toBeGreaterThan(first);

    const before = (await caller2.dms.getChannels()).find((c) => c.id === channel.id);
    expect(before!.unreadCount).toBe(2);

    await caller1.dms.deleteMessage({ messageId: last });

    const after = (await caller2.dms.getChannels()).find((c) => c.id === channel.id);
    expect(after!.unreadCount).toBe(1);
    expect(after!.lastMessage).toMatchObject({ id: last, content: null, deletedBy: 1 });
    expect(after!.lastMessage!.deletedAt).toBeGreaterThan(0);
  });
});

describe('dms.toggleReaction bounds', () => {
  test('emoji must be 1..64 chars', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const dmMessageId = await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'react'
    });

    await expect(
      caller1.dms.toggleReaction({ dmMessageId, emoji: '' })
    ).rejects.toThrow();
    await expect(
      caller1.dms.toggleReaction({ dmMessageId, emoji: 'x'.repeat(65) })
    ).rejects.toThrow();
    await expect(
      caller1.dms.toggleReaction({ dmMessageId: 1.5, emoji: '👍' })
    ).rejects.toThrow();
    await caller1.dms.toggleReaction({ dmMessageId, emoji: 'x'.repeat(64) });
    const page = await caller1.dms.getMessages({ dmChannelId: channel.id });
    expect(
      page.messages.find((m) => m.id === dmMessageId)!.reactions
    ).toHaveLength(1);
  });
});

describe('dms.getMessages after (forward paging)', () => {
  afterEach(() => mock.restore());

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

  const seedHistory = async (dmChannelId: number, count: number) => {
    const base = Date.now() - 600_000;
    // Distinct, increasing createdAt so the strict gt()/lt() cursors are
    // unambiguous.
    return getTestDb()
      .insert(dmMessages)
      .values(
        Array.from({ length: count }, (_, i) => ({
          dmChannelId,
          userId: 2,
          content: `m${i}`,
          createdAt: base + i * 1000
        }))
      )
      .returning({ id: dmMessages.id, createdAt: dmMessages.createdAt });
  };

  test('pages toward the present newest-first, reports afterCursor until the tail, never writes read state', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const rows = await seedHistory(channel.id, 7);
    const markerBefore = await readMarker(1, channel.id);

    const spy = spyOn(pubsub, 'publishFor');
    // Strictly newer than m1, three at a time: m2..m4, more remain.
    const page1 = await caller1.dms.getMessages({
      dmChannelId: channel.id,
      after: rows[1]!.createdAt,
      limit: 3
    });
    expect(page1.messages.map((m) => m.content)).toEqual(['m4', 'm3', 'm2']);
    expect(page1.nextCursor).toBeNull();
    // The cursor is the newest RETURNED row, so the next page's strict
    // gt() starts exactly after it — nothing lost at the boundary.
    expect(page1.afterCursor).toBe(rows[4]!.createdAt);

    const page2 = await caller1.dms.getMessages({
      dmChannelId: channel.id,
      after: page1.afterCursor!,
      limit: 3
    });
    expect(page2.messages.map((m) => m.content)).toEqual(['m6', 'm5']);
    expect(page2.afterCursor).toBeNull();

    // Past the tail: empty, attached.
    const page3 = await caller1.dms.getMessages({
      dmChannelId: channel.id,
      after: rows[6]!.createdAt
    });
    expect(page3.messages).toEqual([]);
    expect(page3.afterCursor).toBeNull();

    // Forward pages are not "opening the conversation": no marker write,
    // no read-state publish (the client marks read when it reaches the
    // tail, through dms.markChannelAsRead).
    expect(await readMarker(1, channel.id)).toBe(markerBefore);
    const readStatePublishes = spy.mock.calls.filter(
      ([, topic]) => topic === ServerEvents.DM_READ_STATE_UPDATE
    );
    expect(readStatePublishes).toHaveLength(0);

    // The first page still does.
    await caller1.dms.getMessages({ dmChannelId: channel.id, limit: 2 });
    expect(await readMarker(1, channel.id)).toBe(rows[6]!.id);
  });

  test('after wins over cursor; membership and bounds apply', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    const rows = await seedHistory(channel.id, 3);

    const page = await caller1.dms.getMessages({
      dmChannelId: channel.id,
      after: rows[1]!.createdAt,
      cursor: rows[2]!.createdAt
    });
    expect(page.messages.map((m) => m.content)).toEqual(['m2']);

    await expect(
      caller3.dms.getMessages({ dmChannelId: channel.id, after: 1 })
    ).rejects.toThrow('You are not a member of this DM channel');
    await expect(
      caller1.dms.getMessages({ dmChannelId: channel.id, after: 1.5 })
    ).rejects.toThrow();
    await expect(
      caller1.dms.getMessages({ dmChannelId: channel.id, after: 0 })
    ).rejects.toThrow();
    await expect(
      caller1.dms.getMessages({ dmChannelId: channel.id, after: 1, limit: 101 })
    ).rejects.toThrow();
  });
});
