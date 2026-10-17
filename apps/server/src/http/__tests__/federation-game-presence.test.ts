/**
 * Game presence across federation.
 *
 * Receive (POST /federation/user-info-update with `gamePresence` +
 * `gamePresenceHiddenServers`): the shadow row takes the presence, the
 * home's per-server opt-out is mirrored onto the shadow's preferences
 * as OUR server ids, and every roster the shadow is on gets a scoped
 * USER_UPDATE under that rule; a malformed presence applies as cleared.
 *
 * Send (relayGamePresence): one transient push per peer the user has a
 * federated membership on, carrying the presence as shared and the
 * hidden publicIds that belong to THAT peer; nothing when sharing is
 * off, nothing for a shadow, nothing queued in the outbox.
 *
 * Same fetch-spy + DNS-mock approach as the other dispatcher tests;
 * federation is flipped on at module load like federation-handlers.
 */
import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import {
  federationOutbox,
  servers,
  userFederatedServers,
  userPreferences,
  users
} from '../../db/schema';
import {
  mockDns,
  postSignedAsPeer,
  seedPeer,
  seedPeerInstance,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import {
  createTestServerMember,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../../utils/federation';
import {
  hiddenPublicIdsForPeer,
  relayGamePresence
} from '../../utils/federation-game-presence-dispatch';
import { pubsub } from '../../utils/pubsub';

config.federation.enabled = true;

afterEach(() => {
  mock.restore();
});

type TScopedUpdate = {
  id: number;
  gamePresence?: { name: string; startedAt: number } | null;
  scopeServerPublicId?: string;
};

async function collectUserUpdates<T>(fn: () => Promise<T>) {
  const payloads: TScopedUpdate[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (userIds: unknown, topic: string, payload: unknown) => {
    if (topic === ServerEvents.USER_UPDATE) payloads.push(payload as TScopedUpdate);
    return original(userIds as never, topic as never, payload as never);
  };
  try {
    const result = await fn();
    return { result, payloads };
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = original;
  }
}

const REMOTE_PID = 'remote-pid-game-presence';

/** A shadow of a peer's user, member of the bootstrap server and of `other`. */
async function seedShadowMember(peerInstanceId: number, otherServerId: number) {
  const [shadow] = await db
    .insert(users)
    .values({
      name: 'GamerShadow',
      supabaseId: 'shadow-game-presence',
      publicId: 'shadow-pid-game-presence',
      isFederated: true,
      federatedInstanceId: peerInstanceId,
      federatedPublicId: REMOTE_PID,
      createdAt: Date.now()
    })
    .returning({ id: users.id });
  await createTestServerMember({ serverId: 1, userId: shadow!.id });
  await createTestServerMember({ serverId: otherServerId, userId: shadow!.id });
  return shadow!.id;
}

const storedPresence = async (userId: number) => {
  const [row] = await db
    .select({ gamePresence: users.gamePresence })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.gamePresence ?? null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForRelays = async <T extends { url: string }>(
  calls: T[],
  n: number
): Promise<T[]> => {
  const among = () => calls.filter((c) => c.url.includes('/federation/user-info-update'));
  for (let i = 0; i < 200 && among().length < n; i++) await sleep(10);
  return among();
};

describe('POST /federation/user-info-update — gamePresence', () => {
  test('applies the presence per server under the mirrored hidden list', async () => {
    const { caller } = await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const other = await insertOtherServer();
    const shadowId = await seedShadowMember(peerInstanceId, other.id);
    const [home] = await db
      .select({ publicId: servers.publicId })
      .from(servers)
      .where(eq(servers.id, 1))
      .limit(1);
    const homePublicId = home!.publicId;
    const startedAt = Date.now() - 60_000;

    const { result: res, payloads } = await collectUserUpdates(() =>
      postSignedAsPeer(
        '/federation/user-info-update',
        {
          subjectPublicId: REMOTE_PID,
          gamePresence: { name: 'Rocket Pass', startedAt },
          gamePresenceHiddenServers: [other.publicId, 'not-one-of-ours']
        },
        peerPrivateJwk
      )
    );
    expect(res.status).toBe(200);
    expect(res.body?.applied).toBe(true);

    expect(await storedPresence(shadowId)).toEqual({ name: 'Rocket Pass', startedAt });

    // The opt-out is mirrored as our server id; the unknown publicId is dropped.
    const [prefs] = await db
      .select({ data: userPreferences.data })
      .from(userPreferences)
      .where(eq(userPreferences.userId, shadowId))
      .limit(1);
    expect(prefs?.data.presence).toEqual({ shareGame: true, hiddenServers: [other.id] });

    const scoped = payloads.filter(
      (p) => p.id === shadowId && p.scopeServerPublicId !== undefined
    );
    expect(scoped).toHaveLength(2);
    expect(
      scoped.find((p) => p.scopeServerPublicId === homePublicId)?.gamePresence?.name
    ).toBe('Rocket Pass');
    expect(
      scoped.find((p) => p.scopeServerPublicId === other.publicId)?.gamePresence
    ).toBeNull();

    // The roster reads the shadow like a local user.
    const roster = await caller.others.getServerMembers();
    expect(roster.find((u) => u.id === shadowId)?.gamePresence?.name).toBe('Rocket Pass');
  });

  test('null clears, and a malformed presence applies as cleared', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const other = await insertOtherServer();
    const shadowId = await seedShadowMember(peerInstanceId, other.id);
    await db
      .update(users)
      .set({ gamePresence: { name: 'Stale', startedAt: Date.now() } })
      .where(eq(users.id, shadowId));

    const cleared = await postSignedAsPeer(
      '/federation/user-info-update',
      { subjectPublicId: REMOTE_PID, gamePresence: null },
      peerPrivateJwk
    );
    expect(cleared.status).toBe(200);
    expect(await storedPresence(shadowId)).toBeNull();

    await db
      .update(users)
      .set({ gamePresence: { name: 'Stale', startedAt: Date.now() } })
      .where(eq(users.id, shadowId));
    const malformed = await postSignedAsPeer(
      '/federation/user-info-update',
      { subjectPublicId: REMOTE_PID, gamePresence: { name: '', startedAt: 'soon' } },
      peerPrivateJwk
    );
    expect(malformed.status).toBe(200);
    expect(await storedPresence(shadowId)).toBeNull();
  });

  test('bounds the name and clamps a future start to now', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const other = await insertOtherServer();
    const shadowId = await seedShadowMember(peerInstanceId, other.id);
    const before = Date.now();

    const res = await postSignedAsPeer(
      '/federation/user-info-update',
      {
        subjectPublicId: REMOTE_PID,
        gamePresence: { name: 'x'.repeat(200), startedAt: before + 10 * 60_000 }
      },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);

    const stored = await storedPresence(shadowId);
    expect(stored?.name).toHaveLength(64);
    expect(stored!.startedAt).toBeGreaterThanOrEqual(before);
    expect(stored!.startedAt).toBeLessThanOrEqual(Date.now());
  });
});

describe('relayGamePresence', () => {
  test('pushes the shared presence and that peer\'s hidden publicIds, transiently', async () => {
    const { caller } = await initTest(1);
    await generateFederationKeys();
    mockDns();
    const peerA = 'peer-a.presence.example';
    const peerB = 'peer-b.presence.example';
    const instanceA = await seedPeerInstance(peerA);
    const instanceB = await seedPeerInstance(peerB);
    await db.insert(userFederatedServers).values([
      {
        userId: 1,
        instanceId: instanceA,
        remoteServerId: 10,
        remoteServerPublicId: 'srv-a1',
        joinedAt: Date.now()
      },
      {
        userId: 1,
        instanceId: instanceA,
        remoteServerId: 11,
        remoteServerPublicId: 'srv-a2',
        joinedAt: Date.now()
      },
      {
        userId: 1,
        instanceId: instanceB,
        remoteServerId: 20,
        remoteServerPublicId: 'srv-b1',
        joinedAt: Date.now()
      }
    ]);
    await caller.users.updatePreferences({
      presence: {
        shareGame: true,
        hiddenServers: [`${peerA}:srv-a2`, `${peerB}:srv-b1`, 7]
      }
    });
    await db
      .update(users)
      .set({ gamePresence: { name: 'Rocket Pass', startedAt: 1_700_000_000_000 } })
      .where(eq(users.id, 1));
    const { calls } = spyOnFetch();

    await relayGamePresence(1);
    const relays = await waitForRelays(calls, 2);

    // One per peer, deduplicated across the two servers on peer A.
    expect(relays).toHaveLength(2);
    const toA = relays.find((c) => c.url.includes(peerA))!;
    const toB = relays.find((c) => c.url.includes(peerB))!;
    expect(toA.body.gamePresence).toEqual({ name: 'Rocket Pass', startedAt: 1_700_000_000_000 });
    expect(toA.body.gamePresenceHiddenServers).toEqual(['srv-a2']);
    expect(toB.body.gamePresenceHiddenServers).toEqual(['srv-b1']);
    expect(typeof toA.body.subjectPublicId).toBe('string');
    // Transient: nothing waits in the outbox.
    expect(await db.select().from(federationOutbox)).toHaveLength(0);
  });

  test('sends null when sharing is off, and nothing without a federated membership', async () => {
    const { caller } = await initTest(1);
    await generateFederationKeys();
    mockDns();
    const peer = 'peer-off.presence.example';
    const { calls } = spyOnFetch();

    // No membership on any peer: no push at all.
    await db
      .update(users)
      .set({ gamePresence: { name: 'Rocket Pass', startedAt: Date.now() } })
      .where(eq(users.id, 1));
    await relayGamePresence(1);
    await sleep(40);
    expect(await waitForRelays(calls, 0)).toHaveLength(0);

    const instanceId = await seedPeerInstance(peer);
    await db.insert(userFederatedServers).values({
      userId: 1,
      instanceId,
      remoteServerId: 30,
      remoteServerPublicId: 'srv-off',
      joinedAt: Date.now()
    });
    await caller.users.updatePreferences({ presence: { shareGame: false } });
    // updatePreferences cleared the stored game and relayed once; the
    // explicit relay below is what this test asserts on.
    await waitForRelays(calls, 1);
    calls.length = 0;

    await relayGamePresence(1);
    const relays = await waitForRelays(calls, 1);
    expect(relays).toHaveLength(1);
    expect(relays[0]!.body.gamePresence).toBeNull();
    expect(relays[0]!.body.gamePresenceHiddenServers).toEqual([]);
  });

  test('a shadow never announces presence', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    const instanceId = await seedPeerInstance('peer-shadow.presence.example');
    const [shadow] = await db
      .insert(users)
      .values({
        name: 'Shadow',
        supabaseId: 'shadow-relay-game-presence',
        publicId: 'shadow-relay-pid',
        isFederated: true,
        federatedInstanceId: instanceId,
        federatedPublicId: 'remote-relay-pid',
        gamePresence: { name: 'Rocket Pass', startedAt: Date.now() },
        createdAt: Date.now()
      })
      .returning({ id: users.id });
    const { calls } = spyOnFetch();

    await relayGamePresence(shadow!.id);
    await sleep(40);

    expect(await waitForRelays(calls, 0)).toHaveLength(0);
  });

  test('hiddenPublicIdsForPeer keeps only that peer\'s keys', () => {
    expect(
      hiddenPublicIdsForPeer(
        [3, 'peer.one:abc', 'peer.two:def', 'peer.one:ghi', 'peer.one.evil:zzz'],
        'peer.one'
      )
    ).toEqual(['abc', 'ghi']);
  });
});
