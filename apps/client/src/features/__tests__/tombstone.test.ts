import { describe, expect, test } from 'bun:test';
import type { TJoinedDmChannel, TJoinedDmMessage, TJoinedMessage } from '@pulse/server/types';
import { dmsSliceActions, dmsSliceReducer } from '../dms/slice';
import { serverSliceActions, serverSliceReducer } from '../server/slice';
import { isTombstone, markTombstoned, tombstoneAudit } from '../tombstone';

/**
 * Message tombstones on the client: what a deletion leaves in the lists
 * (features/tombstone.ts, applied by both slices) and who sees the
 * "deleted by" line.
 */

const message = (id: number, extra: Partial<TJoinedMessage> = {}) =>
  ({
    id,
    channelId: 5,
    userId: 2,
    content: `text ${id}`,
    e2ee: false,
    edited: true,
    pinned: true,
    pinnedAt: 10,
    pinnedBy: 1,
    metadata: [{ url: 'https://example.org', title: 'x' }],
    mentionedUserIds: [1],
    mentionsAll: false,
    forwardedFromUserId: 9,
    forwardedFromName: 'Nine',
    threadId: 77,
    replyToId: null,
    type: 'user',
    createdAt: id,
    updatedAt: null,
    deletedAt: null,
    deletedBy: null,
    files: [{ id: 1 }],
    reactions: [{ emoji: '👍' }],
    replyTo: null,
    ...extra
  }) as unknown as TJoinedMessage;

const TOMB = { deletedAt: 1_700_000_000_000, deletedBy: 1 };

describe('markTombstoned', () => {
  test('clears everything the message carried, records the deletion, keeps thread/type/reply links', () => {
    const [row] = markTombstoned([message(1)], [1], TOMB);
    expect(row).toMatchObject({
      id: 1,
      content: null,
      files: [],
      reactions: [],
      metadata: null,
      mentionedUserIds: null,
      mentionsAll: false,
      edited: false,
      pinned: false,
      pinnedAt: null,
      pinnedBy: null,
      forwardedFromUserId: null,
      forwardedFromName: null,
      deletedAt: TOMB.deletedAt,
      deletedBy: 1,
      threadId: 77,
      type: 'user',
      userId: 2,
      createdAt: 1
    });
    expect(isTombstone(row!)).toBe(true);
  });

  test('a reply to a tombstoned message shows the deleted target; other rows are returned as they were', () => {
    const untouched = message(3);
    const reply = message(2, { replyToId: 1, replyTo: { id: 1, userId: 2, content: 'text 1', hasFiles: true } });
    const out = markTombstoned([message(1), reply, untouched], new Set([1]), TOMB);

    expect(out[1]!.replyTo).toEqual({ id: 1, userId: 2, content: null, hasFiles: false });
    expect(out[1]!.content).toBe('text 2');
    expect(out[2]).toBe(untouched);
    expect(isTombstone(out[1]!)).toBe(false);
  });

  test('an unknown id or an empty set is a no-op', () => {
    const list = [message(1)];
    expect(markTombstoned(list, [], TOMB)).toBe(list);
    expect(markTombstoned(list, [42], TOMB)[0]).toBe(list[0]);
  });
});

describe('tombstoneAudit — who sees "deleted by"', () => {
  const row = { deletedAt: TOMB.deletedAt, deletedBy: 1 };

  test('a live message has no audit for anyone', () => {
    expect(tombstoneAudit({ deletedAt: null, deletedBy: null }, true, 'Mod')).toBeNull();
    expect(tombstoneAudit({}, true, 'Mod')).toBeNull();
  });

  test('a member (no MANAGE_MESSAGES) sees nothing beyond "Message deleted"', () => {
    expect(tombstoneAudit(row, false, 'Mod')).toBeNull();
  });

  test('a MANAGE_MESSAGES holder sees the deleter and the time', () => {
    expect(tombstoneAudit(row, true, 'Mod')).toEqual({ deleterName: 'Mod', deletedAt: TOMB.deletedAt });
  });

  test('an unknown deleter (peer instance, departed account) still shows the time to moderators', () => {
    expect(tombstoneAudit({ deletedAt: TOMB.deletedAt, deletedBy: null }, true, 'ignored')).toEqual({
      deleterName: null,
      deletedAt: TOMB.deletedAt
    });
    // deletedBy set but the roster cannot resolve it: the line says "deleted", not a wrong name.
    expect(tombstoneAudit(row, true, undefined)).toEqual({ deleterName: null, deletedAt: TOMB.deletedAt });
  });
});

describe('server slice — deletions mark in place', () => {
  const base = serverSliceReducer(
    serverSliceReducer(undefined, { type: '@@init' }),
    serverSliceActions.addMessages({ channelId: 5, messages: [message(1), message(2), message(3)] })
  );

  test('deleteMessage keeps the row, in place, as a tombstone', () => {
    const s = serverSliceReducer(
      base,
      serverSliceActions.deleteMessage({ channelId: 5, messageId: 2, tombstone: TOMB })
    );
    expect(s.messagesMap[5]!.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(s.messagesMap[5]![1]).toMatchObject({ id: 2, content: null, deletedAt: TOMB.deletedAt, deletedBy: 1 });
    expect(s.messagesMap[5]![0]!.content).toBe('text 1');
  });

  test('bulkDeleteMessages marks every id; an unknown channel is a no-op', () => {
    const s = serverSliceReducer(
      base,
      serverSliceActions.bulkDeleteMessages({ channelId: 5, messageIds: [1, 3], tombstone: TOMB })
    );
    expect(s.messagesMap[5]!.map((m) => m.deletedAt)).toEqual([TOMB.deletedAt, null, TOMB.deletedAt]);
    expect(
      serverSliceReducer(base, serverSliceActions.bulkDeleteMessages({ channelId: 9, messageIds: [1], tombstone: TOMB }))
    ).toEqual(base);
  });
});

describe('dms slice — deletions mark in place and the sidebar snippet', () => {
  const dmMessage = (id: number) =>
    ({ ...message(id), dmChannelId: 4, channelId: undefined }) as unknown as TJoinedDmMessage;
  const channel = (id: number, lastMessage: TJoinedDmMessage | null) =>
    ({ id, name: null, isGroup: false, members: [], unreadCount: 0, lastMessage }) as unknown as TJoinedDmChannel;

  const base = dmsSliceReducer(
    dmsSliceReducer(
      dmsSliceReducer(undefined, { type: '@@init' }),
      dmsSliceActions.setChannels([channel(4, dmMessage(2)), channel(6, dmMessage(2))])
    ),
    dmsSliceActions.addMessages({ dmChannelId: 4, messages: [dmMessage(1), dmMessage(2)] })
  );

  test('deleteMessage tombstones the row and the channel\'s lastMessage when it is the one', () => {
    const s = dmsSliceReducer(
      base,
      dmsSliceActions.deleteMessage({ dmChannelId: 4, dmMessageId: 2, tombstone: TOMB })
    );
    expect(s.messagesMap[4]!.map((m) => m.id)).toEqual([1, 2]);
    expect(s.messagesMap[4]![1]).toMatchObject({ content: null, deletedAt: TOMB.deletedAt, deletedBy: 1 });
    expect(s.channels[0]!.lastMessage).toMatchObject({ id: 2, content: null, deletedAt: TOMB.deletedAt });
    // Another channel whose last message happens to share the id is untouched.
    expect(s.channels[1]!.lastMessage!.content).toBe('text 2');
  });

  test('deleting a message that is not the last leaves the snippet alone', () => {
    const s = dmsSliceReducer(
      base,
      dmsSliceActions.deleteMessage({ dmChannelId: 4, dmMessageId: 1, tombstone: TOMB })
    );
    expect(s.channels[0]!.lastMessage!.content).toBe('text 2');
    expect(s.messagesMap[4]![0]!.deletedAt).toBe(TOMB.deletedAt);
  });
});
