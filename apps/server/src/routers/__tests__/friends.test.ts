import { ServerEvents } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { seedPeerInstance } from '../../__tests__/federation-fixtures';
import { createTestUser } from '../../__tests__/fixtures';
import { firstSubscriptionEvent, initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  federationInstances,
  federationOutbox,
  friendRequests,
  friendships,
  serverMembers,
  users
} from '../../db/schema';
import { _setOutboxRelayForTests } from '../../utils/federation-outbox';
import { pubsub } from '../../utils/pubsub';

/**
 * friends router: the full local loop (send / accept / reject / remove,
 * with the duplicate, self and not-friends errors), the four `on*`
 * subscriptions, and the three federated relays. The relays are
 * asserted on the durable outbox (`federation_outbox` row: path +
 * payload) — not on a relay spy — with the network attempt stubbed to
 * fail so the row stays in place to be inspected. Access-control probes
 * (shared-server gate, blocks) live in access-control.test.ts and
 * blocks.test.ts; the inbound receivers in federation-core-handlers.
 */

type PublishCall = [number | number[], string, Record<string, unknown>];

const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

const requestRows = () => getTestDb().select().from(friendRequests);
const friendshipRows = () => getTestDb().select().from(friendships);

const befriend = async (a: number, b: number) => {
  await getTestDb()
    .insert(friendships)
    .values({ userId: a, friendId: b, createdAt: Date.now() });
};

const PEER = 'peer.friends.example';

/**
 * A shadow of a peer user that is ALSO a member of server 1, so the
 * local shared-server gate passes (config.federation.enabled is false
 * in tests, which disables the remote attestation arm).
 */
const seedShadowMember = async () => {
  const tdb = getTestDb();
  const instanceId = await seedPeerInstance(PEER);
  const suffix = randomUUIDv7();
  const [shadow] = await tdb
    .insert(users)
    .values({
      name: 'Remote Friend',
      supabaseId: `shadow-${suffix}`,
      publicId: `local-mirror-${suffix}`,
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedUsername: 'remotefriend',
      federatedPublicId: `remote-pid-${suffix}`,
      createdAt: Date.now()
    })
    .returning();
  await tdb.insert(serverMembers).values({
    serverId: 1,
    userId: shadow!.id,
    joinedAt: Date.now(),
    position: 0
  });
  return shadow!;
};

/** The relay is fire-and-forget; wait for its outbox row to land. */
const waitForOutboxRow = async (path: string) => {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const [row] = await getTestDb()
      .select()
      .from(federationOutbox)
      .where(eq(federationOutbox.path, path));
    if (row) return row;
    if (Date.now() > deadline) {
      throw new Error(`no federation_outbox row for ${path} within 3s`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Stub the network attempt to fail so the enqueued row persists. */
const stubRelayDown = () => {
  const attempts: { domain: string; path: string }[] = [];
  _setOutboxRelayForTests(async (domain, path) => {
    attempts.push({ domain, path });
    return { ok: false, error: 'peer unreachable' };
  });
  return attempts;
};

const publicIdOf = async (userId: number) => {
  const [row] = await getTestDb()
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, userId));
  return row!.publicId;
};

afterEach(() => {
  _setOutboxRelayForTests(undefined);
  mock.restore();
});

describe('friends local loop', () => {
  test('send → pending for both → accept → friends both ways', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    const requestId = await caller1.friends.sendRequest({ userId: 2 });
    expect(requestId).toBeGreaterThan(0);

    const pendingForSender = await caller1.friends.getRequests();
    const pendingForReceiver = await caller2.friends.getRequests();
    expect(pendingForSender.map((r) => r.id)).toEqual([requestId]);
    expect(pendingForReceiver.map((r) => r.id)).toEqual([requestId]);
    expect(pendingForReceiver[0]).toMatchObject({
      senderId: 1,
      receiverId: 2,
      status: 'pending',
      sender: { id: 1, name: 'Test Owner' },
      receiver: { id: 2, name: 'Test User' }
    });
    expect(await caller1.friends.getAll()).toEqual([]);

    await caller2.friends.acceptRequest({ requestId });

    const [row] = await requestRows();
    expect(row!.status).toBe('accepted');
    expect(await friendshipRows()).toHaveLength(1);
    expect((await caller1.friends.getAll()).map((f) => f.id)).toEqual([2]);
    expect((await caller2.friends.getAll()).map((f) => f.id)).toEqual([1]);
    expect(await caller1.friends.getRequests()).toEqual([]);
    expect(await caller2.friends.getRequests()).toEqual([]);
  });

  test('getAll carries a runtime status for each friend', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await befriend(1, 2);

    const [friend] = await caller1.friends.getAll();
    expect(friend!.id).toBe(2);
    expect(typeof friend!.status).toBe('string');
  });

  test('self-request, duplicate pending (either direction) and already-friends are refused', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);

    await expect(caller1.friends.sendRequest({ userId: 1 })).rejects.toThrow(
      'You cannot send a friend request to yourself'
    );

    await caller1.friends.sendRequest({ userId: 2 });
    await expect(caller1.friends.sendRequest({ userId: 2 })).rejects.toThrow(
      'A pending friend request already exists'
    );
    await expect(caller2.friends.sendRequest({ userId: 1 })).rejects.toThrow(
      'A pending friend request already exists'
    );

    await befriend(1, 3);
    await expect(caller1.friends.sendRequest({ userId: 3 })).rejects.toThrow(
      'You are already friends with this user'
    );

    expect(await requestRows()).toHaveLength(1);
  });

  test('a request to an unknown user id is refused and writes nothing', async () => {
    const { caller: caller1 } = await initTest(1);

    await expect(
      caller1.friends.sendRequest({ userId: 999_999 })
    ).rejects.toThrow();
    expect(await requestRows()).toHaveLength(0);
  });

  test('only the receiver can accept; the sender and a third party are refused', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const requestId = await caller1.friends.sendRequest({ userId: 2 });

    await expect(caller1.friends.acceptRequest({ requestId })).rejects.toThrow(
      'You can only accept requests sent to you'
    );
    await expect(caller3.friends.acceptRequest({ requestId })).rejects.toThrow(
      'You can only accept requests sent to you'
    );
    await expect(
      caller1.friends.acceptRequest({ requestId: 999_999 })
    ).rejects.toThrow('Friend request not found');

    expect(await friendshipRows()).toHaveLength(0);
  });

  test('accepting twice is refused once the request is no longer pending', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const requestId = await caller1.friends.sendRequest({ userId: 2 });

    await caller2.friends.acceptRequest({ requestId });
    await expect(caller2.friends.acceptRequest({ requestId })).rejects.toThrow(
      'This request is no longer pending'
    );
    expect(await friendshipRows()).toHaveLength(1);
  });

  test('reject: receiver only, marks the row rejected, and the sender may ask again', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);
    const requestId = await caller1.friends.sendRequest({ userId: 2 });

    await expect(caller1.friends.rejectRequest({ requestId })).rejects.toThrow(
      'You can only reject requests sent to you'
    );
    await expect(caller3.friends.rejectRequest({ requestId })).rejects.toThrow(
      'You can only reject requests sent to you'
    );
    await expect(
      caller2.friends.rejectRequest({ requestId: 999_999 })
    ).rejects.toThrow('Friend request not found');

    await caller2.friends.rejectRequest({ requestId });
    const [row] = await requestRows();
    expect(row!.status).toBe('rejected');
    expect(await caller1.friends.getRequests()).toEqual([]);
    expect(await caller2.friends.getRequests()).toEqual([]);

    await expect(caller2.friends.rejectRequest({ requestId })).rejects.toThrow(
      'This request is no longer pending'
    );

    // The terminal row is cleared so the re-request has a clean slot.
    const again = await caller1.friends.sendRequest({ userId: 2 });
    expect(again).not.toBe(requestId);
    const rows = await requestRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: again, status: 'pending' });
  });

  test('remove: refused when not friends, deletes either stored direction, both sides notified', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    await befriend(1, 2);
    await befriend(3, 1);

    await expect(
      caller1.friends.remove({ userId: 999_999 })
    ).rejects.toThrow('You are not friends with this user');

    const spy = spyOn(pubsub, 'publishFor');
    await caller1.friends.remove({ userId: 2 });
    await caller1.friends.remove({ userId: 3 });

    expect(await friendshipRows()).toHaveLength(0);
    expect(await caller1.friends.getAll()).toEqual([]);

    const removed = callsFor(spy, ServerEvents.FRIEND_REMOVED);
    expect(removed.map(([userIds, , payload]) => [userIds, payload])).toEqual([
      [1, { userId: 1, friendId: 2 }],
      [2, { userId: 1, friendId: 2 }],
      [1, { userId: 1, friendId: 3 }],
      [3, { userId: 1, friendId: 3 }]
    ]);

    await expect(caller1.friends.remove({ userId: 2 })).rejects.toThrow(
      'You are not friends with this user'
    );
  });

  test('ids must be numbers', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.friends.sendRequest({ userId: '2' as unknown as number })
    ).rejects.toThrow();
    await expect(
      caller.friends.acceptRequest({ requestId: null as unknown as number })
    ).rejects.toThrow();
    await expect(
      caller.friends.rejectRequest({ requestId: 'x' as unknown as number })
    ).rejects.toThrow();
    await expect(
      caller.friends.remove({ userId: undefined as unknown as number })
    ).rejects.toThrow();
  });
});

describe('friends events', () => {
  test('send publishes FRIEND_REQUEST_RECEIVED to receiver and sender', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);

    const spy = spyOn(pubsub, 'publishFor');
    const requestId = await caller1.friends.sendRequest({ userId: 2 });

    const received = callsFor(spy, ServerEvents.FRIEND_REQUEST_RECEIVED);
    expect(received.map(([userIds]) => userIds)).toEqual([2, 1]);
    expect(received[0]![2]).toMatchObject({ id: requestId, status: 'pending' });
  });

  test('onRequestReceived yields the joined request to the receiver', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    const event = await firstSubscriptionEvent<{
      senderId: number;
      receiverId: number;
      status: string;
      sender: { name: string };
    }>(caller2, 'friends', 'onRequestReceived', () =>
      caller1.friends.sendRequest({ userId: 2 })
    );
    expect(event).toMatchObject({
      senderId: 1,
      receiverId: 2,
      status: 'pending',
      sender: { name: 'Test Owner' }
    });
  });

  test('onRequestAccepted yields the accepted request to the sender', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const requestId = await caller1.friends.sendRequest({ userId: 2 });

    const event = await firstSubscriptionEvent<{ id: number; status: string }>(
      caller1,
      'friends',
      'onRequestAccepted',
      () => caller2.friends.acceptRequest({ requestId })
    );
    expect(event).toMatchObject({ id: requestId, status: 'accepted' });
  });

  test('onRequestRejected yields the rejected request to the sender', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const requestId = await caller1.friends.sendRequest({ userId: 2 });

    const event = await firstSubscriptionEvent<{ id: number; status: string }>(
      caller1,
      'friends',
      'onRequestRejected',
      () => caller2.friends.rejectRequest({ requestId })
    );
    expect(event).toMatchObject({ id: requestId, status: 'rejected' });
  });

  test('onRemoved yields the pair to the removed friend', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await befriend(1, 2);

    const event = await firstSubscriptionEvent(caller2, 'friends', 'onRemoved', () =>
      caller1.friends.remove({ userId: 2 })
    );
    expect(event).toEqual({ userId: 1, friendId: 2 });
  });

  test('a third user hears nothing', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const { caller: caller3 } = await initTest(3);

    await expect(
      firstSubscriptionEvent(
        caller3,
        'friends',
        'onRequestReceived',
        () => caller1.friends.sendRequest({ userId: 2 }),
        { timeoutMs: 150 }
      )
    ).rejects.toThrow('yielded no event');
  });
});

describe('friends federated relays (outbox)', () => {
  test('sendRequest to a shadow user enqueues /federation/friend-request', async () => {
    const { caller: caller1 } = await initTest(1);
    const shadow = await seedShadowMember();
    const attempts = stubRelayDown();

    const requestId = await caller1.friends.sendRequest({ userId: shadow.id });
    expect(requestId).toBeGreaterThan(0);

    const row = await waitForOutboxRow('/federation/friend-request');
    expect(row.payload).toEqual({
      fromUsername: 'Test Owner',
      fromPublicId: await publicIdOf(1),
      fromAvatarFile: null,
      toUsername: 'Remote Friend',
      toPublicId: shadow.federatedPublicId,
      fromUserId: 1
    });
    // Attempted once inline, failed, scheduled for the cron.
    expect(row.attempts).toBe(1);
    expect(row.deadAt).toBeNull();
    expect(row.lastError).toBe('peer unreachable');
    expect(attempts).toEqual([{ domain: PEER, path: '/federation/friend-request' }]);
  });

  test('acceptRequest of a shadow sender enqueues /federation/friend-accept', async () => {
    const { caller: caller1 } = await initTest(1);
    const shadow = await seedShadowMember();
    const attempts = stubRelayDown();
    const [request] = await getTestDb()
      .insert(friendRequests)
      .values({
        senderId: shadow.id,
        receiverId: 1,
        status: 'pending',
        createdAt: Date.now()
      })
      .returning();

    await caller1.friends.acceptRequest({ requestId: request!.id });
    expect(await friendshipRows()).toHaveLength(1);

    const row = await waitForOutboxRow('/federation/friend-accept');
    expect(row.payload).toEqual({
      fromUsername: 'Test Owner',
      fromPublicId: await publicIdOf(1),
      fromAvatarFile: null,
      toUsername: 'Remote Friend',
      toPublicId: shadow.federatedPublicId,
      fromUserId: 1
    });
    expect(attempts).toEqual([{ domain: PEER, path: '/federation/friend-accept' }]);
  });

  test('remove of a shadow friend enqueues /federation/friend-remove', async () => {
    const { caller: caller1 } = await initTest(1);
    const shadow = await seedShadowMember();
    const attempts = stubRelayDown();
    await befriend(1, shadow.id);

    await caller1.friends.remove({ userId: shadow.id });
    expect(await friendshipRows()).toHaveLength(0);

    const row = await waitForOutboxRow('/federation/friend-remove');
    expect(row.payload).toEqual({
      fromPublicId: await publicIdOf(1),
      toPublicId: shadow.federatedPublicId
    });
    expect(attempts).toEqual([{ domain: PEER, path: '/federation/friend-remove' }]);
  });

  test('local-only actions enqueue nothing', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);
    await befriend(1, 3);
    const attempts = stubRelayDown();

    const requestId = await caller1.friends.sendRequest({ userId: 2 });
    await caller2.friends.acceptRequest({ requestId });
    await caller1.friends.remove({ userId: 3 });
    await new Promise((r) => setTimeout(r, 50));

    expect(await getTestDb().select().from(federationOutbox)).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });

  test('a shadow whose home instance is no longer active gets no outbox row', async () => {
    const { caller: caller1 } = await initTest(1);
    const shadow = await seedShadowMember();
    const attempts = stubRelayDown();
    await befriend(1, shadow.id);
    // Deactivating the peer: enqueueRelay drops the relay (peer not
    // active) — the local removal still goes through.
    const tdb = getTestDb();
    await tdb
      .update(federationInstances)
      .set({ status: 'suspended' })
      .where(eq(federationInstances.domain, PEER));

    await caller1.friends.remove({ userId: shadow.id });
    await new Promise((r) => setTimeout(r, 50));

    expect(await friendshipRows()).toHaveLength(0);
    expect(await tdb.select().from(federationOutbox)).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });

  test('a shadow without a federatedPublicId is not relayed (logged, no row)', async () => {
    const { caller: caller1 } = await initTest(1);
    const shadow = await seedShadowMember();
    const attempts = stubRelayDown();
    await getTestDb()
      .update(users)
      .set({ federatedPublicId: null })
      .where(eq(users.id, shadow.id));

    const requestId = await caller1.friends.sendRequest({ userId: shadow.id });
    expect(requestId).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 50));

    expect(await getTestDb().select().from(federationOutbox)).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });

  test('a plain local user is never mistaken for a shadow', async () => {
    const { caller: caller1 } = await initTest(1);
    await seedPeerInstance(PEER);
    const local = await createTestUser({ name: 'plain-local' });
    await getTestDb().insert(serverMembers).values({
      serverId: 1,
      userId: local,
      joinedAt: Date.now(),
      position: 0
    });
    const attempts = stubRelayDown();

    await caller1.friends.sendRequest({ userId: local });
    await new Promise((r) => setTimeout(r, 50));

    expect(await getTestDb().select().from(federationOutbox)).toHaveLength(0);
    expect(attempts).toHaveLength(0);
  });
});
