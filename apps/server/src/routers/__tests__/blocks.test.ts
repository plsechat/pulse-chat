import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { createTestUser } from '../../__tests__/fixtures';
import { firstSubscriptionEvent, initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { friendRequests, friendships, userBlocks } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';

/**
 * blocks router: block / unblock / getBlocked / onBlockChanged, plus the
 * enforcement sites a block drives (DM creation and send, friend
 * requests). Setup is inline per test; `pubsub.publishFor` is spied
 * through spyOn and restored in afterEach.
 */

type PublishCall = [number | number[], string, Record<string, unknown>];

const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

const blockRows = async (blockerId: number) =>
  getTestDb()
    .select()
    .from(userBlocks)
    .where(eq(userBlocks.blockerId, blockerId));

const befriend = async (a: number, b: number) => {
  await getTestDb()
    .insert(friendships)
    .values({ userId: a, friendId: b, createdAt: Date.now() });
};

afterEach(() => {
  mock.restore();
});

describe('blocks.block / unblock / getBlocked', () => {
  test('block writes one row, getBlocked lists the user, unblock removes it', async () => {
    const { caller } = await initTest(1);
    await initTest(2);

    await caller.blocks.block({ userId: 2 });
    expect(await blockRows(1)).toHaveLength(1);

    const blocked = await caller.blocks.getBlocked();
    expect(blocked.map((u) => u.id)).toEqual([2]);
    expect(blocked[0]!.name).toBe('Test User');

    await caller.blocks.unblock({ userId: 2 });
    expect(await blockRows(1)).toHaveLength(0);
    expect(await caller.blocks.getBlocked()).toEqual([]);
  });

  test('blocking twice is idempotent (one row, no error)', async () => {
    const { caller } = await initTest(1);

    await caller.blocks.block({ userId: 2 });
    await caller.blocks.block({ userId: 2 });

    expect(await blockRows(1)).toHaveLength(1);
  });

  test('unblocking a user who was never blocked is a no-op', async () => {
    const { caller } = await initTest(1);

    await expect(caller.blocks.unblock({ userId: 3 })).resolves.toBeUndefined();
    expect(await blockRows(1)).toHaveLength(0);
  });

  test('cannot block yourself', async () => {
    const { caller } = await initTest(1);

    await expect(caller.blocks.block({ userId: 1 })).rejects.toThrow(
      'You cannot block yourself'
    );
    expect(await blockRows(1)).toHaveLength(0);
  });

  test('blocking an unknown user id is refused and writes nothing', async () => {
    const { caller } = await initTest(1);

    await expect(caller.blocks.block({ userId: 999_999 })).rejects.toThrow();
    expect(await blockRows(1)).toHaveLength(0);
  });

  test('userId must be a number', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.blocks.block({ userId: '2' as unknown as number })
    ).rejects.toThrow();
    await expect(
      caller.blocks.unblock({ userId: null as unknown as number })
    ).rejects.toThrow();
  });

  test('getBlocked is scoped to the caller: each user sees only their own list', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const fourth = await createTestUser({ name: 'fourth' });

    await caller1.blocks.block({ userId: 3 });
    await caller1.blocks.block({ userId: fourth });
    await caller2.blocks.block({ userId: 3 });

    expect((await caller1.blocks.getBlocked()).map((u) => u.id).sort()).toEqual(
      [3, fourth].sort()
    );
    expect((await caller2.blocks.getBlocked()).map((u) => u.id)).toEqual([3]);
    // The blocked user never sees who blocked them.
    expect(await caller3.blocks.getBlocked()).toEqual([]);
  });

  test('a block is one-directional in storage: the blocked user can still block back', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.blocks.block({ userId: 2 });
    await caller2.blocks.block({ userId: 1 });

    expect(await blockRows(1)).toHaveLength(1);
    expect(await blockRows(2)).toHaveLength(1);

    // Each side unblocks only its own edge.
    await caller1.blocks.unblock({ userId: 2 });
    expect(await blockRows(1)).toHaveLength(0);
    expect(await blockRows(2)).toHaveLength(1);
  });
});

describe('blocks.block side effects', () => {
  test('tears down the friendship (either stored direction) and tells the blocked user', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    await befriend(1, 2);
    await befriend(3, 1);

    const spy = spyOn(pubsub, 'publishFor');
    await caller1.blocks.block({ userId: 2 });
    await caller1.blocks.block({ userId: 3 });

    expect(await getTestDb().select().from(friendships)).toHaveLength(0);

    // FRIEND_REMOVED reaches the blocked user so their cached roster
    // drops the blocker; the blocker is told via USER_BLOCK_CHANGED.
    const removed = callsFor(spy, ServerEvents.FRIEND_REMOVED);
    expect(removed).toHaveLength(2);
    expect(removed[0]![0]).toBe(2);
    expect(removed[0]![2]).toEqual({ userId: 2, friendId: 1 });
    expect(removed[1]![0]).toBe(3);
    expect(removed[1]![2]).toEqual({ userId: 3, friendId: 1 });
  });

  test('drops a pending friend request in either direction, keeps terminal rows', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    const tdb = getTestDb();
    const now = Date.now();
    await tdb.insert(friendRequests).values([
      { senderId: 1, receiverId: 2, status: 'pending', createdAt: now },
      { senderId: 3, receiverId: 1, status: 'pending', createdAt: now },
      // A history row is not "pending" and must survive the block.
      { senderId: 2, receiverId: 1, status: 'rejected', createdAt: now }
    ]);

    await caller1.blocks.block({ userId: 2 });

    const left = await tdb.select().from(friendRequests);
    expect(left.map((r) => [r.senderId, r.receiverId, r.status])).toEqual(
      expect.arrayContaining([
        [3, 1, 'pending'],
        [2, 1, 'rejected']
      ])
    );
    expect(left).toHaveLength(2);
  });

  test('USER_BLOCK_CHANGED goes to the blocker only, on block and on unblock', async () => {
    const { caller } = await initTest(1);
    await initTest(2);

    const spy = spyOn(pubsub, 'publishFor');
    await caller.blocks.block({ userId: 2 });
    await caller.blocks.unblock({ userId: 2 });

    const changes = callsFor(spy, ServerEvents.USER_BLOCK_CHANGED);
    expect(changes).toHaveLength(2);
    expect(changes[0]![0]).toBe(1);
    expect(changes[0]![2]).toEqual({ blockedUserId: 2, blocked: true });
    expect(changes[1]![0]).toBe(1);
    expect(changes[1]![2]).toEqual({ blockedUserId: 2, blocked: false });
    // Block disclosure is one-way: nothing is published to user 2 here.
    expect(changes.some(([userIds]) => userIds === 2)).toBe(false);
  });

  test('onBlockChanged delivers the change to the blocker', async () => {
    const { caller } = await initTest(1);
    await initTest(2);

    const blockedEvent = await firstSubscriptionEvent(
      caller,
      'blocks',
      'onBlockChanged',
      () => caller.blocks.block({ userId: 2 })
    );
    expect(blockedEvent).toEqual({ blockedUserId: 2, blocked: true });

    const unblockedEvent = await firstSubscriptionEvent(
      caller,
      'blocks',
      'onBlockChanged',
      () => caller.blocks.unblock({ userId: 2 })
    );
    expect(unblockedEvent).toEqual({ blockedUserId: 2, blocked: false });
  });

  test('onBlockChanged on the blocked user stays silent', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await expect(
      firstSubscriptionEvent(
        caller2,
        'blocks',
        'onBlockChanged',
        () => caller1.blocks.block({ userId: 2 }),
        { timeoutMs: 150 }
      )
    ).rejects.toThrow('yielded no event');
  });
});

describe('block enforcement', () => {
  test('a blocked user cannot send in an existing DM, and neither can the blocker', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await caller2.dms.sendMessage({ dmChannelId: channel.id, content: 'before' });

    await caller1.blocks.block({ userId: 2 });

    await expect(
      caller2.dms.sendMessage({ dmChannelId: channel.id, content: 'after' })
    ).rejects.toThrow();
    await expect(
      caller1.dms.sendMessage({ dmChannelId: channel.id, content: 'after' })
    ).rejects.toThrow();

    // Unblocking restores the conversation.
    await caller1.blocks.unblock({ userId: 2 });
    await expect(
      caller2.dms.sendMessage({ dmChannelId: channel.id, content: 'again' })
    ).resolves.toBeGreaterThan(0);
  });

  test('a block in a group DM refuses the send to the whole group', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    await befriend(1, 2);
    await befriend(1, 3);
    const group = await caller1.dms.createGroup({ userIds: [2, 3] });

    await caller2.blocks.block({ userId: 3 });

    await expect(
      caller2.dms.sendMessage({ dmChannelId: group.id, content: 'to all' })
    ).rejects.toThrow();
    // The unblocked member is unaffected.
    await expect(
      caller1.dms.sendMessage({ dmChannelId: group.id, content: 'fine' })
    ).resolves.toBeGreaterThan(0);
  });

  test('DM creation is refused from both sides with a non-disclosing message', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.blocks.block({ userId: 2 });

    await expect(caller1.dms.getOrCreateChannel({ userId: 2 })).rejects.toThrow(
      'Cannot start a DM with this user.'
    );
    await expect(caller2.dms.getOrCreateChannel({ userId: 1 })).rejects.toThrow(
      'Cannot start a DM with this user.'
    );
  });

  test('friend requests are refused from both sides', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.blocks.block({ userId: 2 });

    await expect(caller1.friends.sendRequest({ userId: 2 })).rejects.toThrow(
      'Cannot send a friend request to this user.'
    );
    await expect(caller2.friends.sendRequest({ userId: 1 })).rejects.toThrow(
      'Cannot send a friend request to this user.'
    );
    expect(
      await getTestDb()
        .select()
        .from(friendRequests)
        .where(
          and(eq(friendRequests.senderId, 2), eq(friendRequests.receiverId, 1))
        )
    ).toHaveLength(0);
  });
});
