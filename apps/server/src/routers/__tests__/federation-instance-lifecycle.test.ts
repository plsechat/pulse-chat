/**
 * Instance removal / blocking: the peer is told (`/federation/unpeer`),
 * shadows go, and the DM channels that only existed because of them go
 * with them — while mixed groups and local-only groups survive. Plus
 * the outbox surface on the instance routes (counts, dead-row list,
 * owner retry).
 *
 * Fixture facts: user 1 is the instance owner, users 2/3 are plain
 * members of server 1. Setup inline (no beforeEach).
 */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  federationInstances,
  federationOutbox,
  users
} from '../../db/schema';
import {
  mockDns,
  seedPeerInstance,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../../utils/federation';
import { _setOutboxRelayForTests } from '../../utils/federation-outbox';
import { pubsub } from '../../utils/pubsub';

const PEER_DOMAIN = 'peer.lifecycle.example.com';

afterEach(() => {
  _setOutboxRelayForTests(undefined);
  mock.restore();
});

async function seedShadow(instanceId: number, tag: string): Promise<number> {
  const [shadow] = await db
    .insert(users)
    .values({
      supabaseId: `lifecycle-${tag}`,
      name: tag,
      publicId: `lifecycle-${tag}-pid`,
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId: `remote-${tag}-pid`,
      createdAt: Date.now()
    })
    .returning();
  return shadow!.id;
}

async function seedChannel(
  memberIds: number[],
  opts: { isGroup: boolean; federationGroupId?: string }
): Promise<number> {
  const [channel] = await db
    .insert(dmChannels)
    .values({
      isGroup: opts.isGroup,
      federationGroupId: opts.federationGroupId ?? null,
      ownerId: opts.isGroup ? memberIds[0] : null,
      createdAt: Date.now()
    })
    .returning();
  await db.insert(dmChannelMembers).values(
    memberIds.map((userId) => ({
      dmChannelId: channel!.id,
      userId,
      createdAt: Date.now()
    }))
  );
  return channel!.id;
}

const channelExists = async (id: number) =>
  (await db.select({ id: dmChannels.id }).from(dmChannels).where(eq(dmChannels.id, id)))
    .length === 1;

const memberCount = async (id: number) =>
  (
    await db
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, id))
  ).length;

/**
 * Seeds: a 1:1 (user 1 + shadow A), an all-remote group mirror (A + B),
 * a mixed group mirror (user 1 + user 2 + A), a local-only group
 * (user 1 + user 2).
 */
async function seedScenario() {
  await generateFederationKeys();
  mockDns();
  const instanceId = await seedPeerInstance(PEER_DOMAIN);
  const shadowA = await seedShadow(instanceId, 'a');
  const shadowB = await seedShadow(instanceId, 'b');
  const oneToOne = await seedChannel([1, shadowA], { isGroup: false });
  const remoteMirror = await seedChannel([shadowA, shadowB], {
    isGroup: true,
    federationGroupId: 'fg-remote-only'
  });
  const mixedMirror = await seedChannel([1, 2, shadowA], {
    isGroup: true,
    federationGroupId: 'fg-mixed'
  });
  const localGroup = await seedChannel([1, 2], { isGroup: true });
  return { instanceId, shadowA, shadowB, oneToOne, remoteMirror, mixedMirror, localGroup };
}

describe('federation.removeInstance', () => {
  test('notifies the peer, drops orphaned DM channels and keeps the rest', async () => {
    const { caller } = await initTest(1);
    const s = await seedScenario();
    const { calls } = spyOnFetch();
    const publishFor = spyOn(pubsub, 'publishFor');

    await caller.federation.removeInstance({ instanceId: s.instanceId });

    // Peer told before the row went away.
    const unpeer = calls.filter((c) => c.url.includes('/federation/unpeer'));
    expect(unpeer).toHaveLength(1);
    expect(unpeer[0]!.body.reason).toBe('removed');

    // Shadows and the instance row are gone.
    expect(await db.select().from(users).where(eq(users.federatedInstanceId, s.instanceId))).toHaveLength(0);
    expect(await db.select().from(federationInstances).where(eq(federationInstances.id, s.instanceId))).toHaveLength(0);

    // Orphaned channels went, the others stayed.
    expect(await channelExists(s.oneToOne)).toBe(false);
    expect(await channelExists(s.remoteMirror)).toBe(false);
    expect(await channelExists(s.mixedMirror)).toBe(true);
    expect(await memberCount(s.mixedMirror)).toBe(2);
    expect(await channelExists(s.localGroup)).toBe(true);
    expect(await memberCount(s.localGroup)).toBe(2);

    // User 1 is told the 1:1 is gone; users 1 and 2 that A left the mixed group.
    const deletes = publishFor.mock.calls.filter(
      ([, event]) => event === ServerEvents.DM_CHANNEL_DELETE
    );
    expect(deletes).toEqual([[1, ServerEvents.DM_CHANNEL_DELETE, { dmChannelId: s.oneToOne }]]);
    const removes = publishFor.mock.calls
      .filter(([, event]) => event === ServerEvents.DM_MEMBER_REMOVE)
      .map(([to, , payload]) => [to, payload]);
    expect(removes).toEqual(
      expect.arrayContaining([
        [1, { dmChannelId: s.mixedMirror, userId: s.shadowA }],
        [2, { dmChannelId: s.mixedMirror, userId: s.shadowA }]
      ])
    );
    expect(removes).toHaveLength(2);
  });

  test('a peer that is down does not block the removal', async () => {
    const { caller } = await initTest(1);
    const s = await seedScenario();
    spyOnFetch(() => {
      throw new Error('ECONNREFUSED');
    });

    await caller.federation.removeInstance({ instanceId: s.instanceId });

    expect(await db.select().from(federationInstances).where(eq(federationInstances.id, s.instanceId))).toHaveLength(0);
    expect(await channelExists(s.oneToOne)).toBe(false);
  });
});

describe('federation.blockInstance', () => {
  test('notifies the peer with reason blocked and sweeps the same channels', async () => {
    const { caller } = await initTest(1);
    const s = await seedScenario();
    const { calls } = spyOnFetch();

    await caller.federation.blockInstance({ instanceId: s.instanceId });

    const unpeer = calls.filter((c) => c.url.includes('/federation/unpeer'));
    expect(unpeer).toHaveLength(1);
    expect(unpeer[0]!.body.reason).toBe('blocked');

    const [row] = await db.select().from(federationInstances).where(eq(federationInstances.id, s.instanceId));
    expect(row!.status).toBe('blocked');
    expect(await channelExists(s.oneToOne)).toBe(false);
    expect(await channelExists(s.remoteMirror)).toBe(false);
    expect(await channelExists(s.mixedMirror)).toBe(true);
    expect(await channelExists(s.localGroup)).toBe(true);
  });
});

describe('outbox surface on the instance routes', () => {
  async function seedOutboxRows(instanceId: number) {
    const now = Date.now();
    await db.insert(federationOutbox).values([
      {
        instanceId,
        path: '/federation/dm-relay',
        payload: { relayId: 'r1' },
        attempts: 2,
        nextAttemptAt: now + 60_000,
        lastError: 'http:503',
        createdAt: now
      },
      {
        instanceId,
        path: '/federation/user-info-update',
        payload: { status: 'idle' },
        attempts: 1,
        nextAttemptAt: now,
        lastError: 'unsupported:/federation/user-info-update',
        createdAt: now,
        deadAt: now
      }
    ]);
  }

  test('listInstances and listActiveInstances report pending/dead counts and health', async () => {
    const { caller } = await initTest(1);
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    await seedOutboxRows(instanceId);
    await db
      .update(federationInstances)
      .set({ peerVersion: '0.3.0', lastError: 'unsupported:/federation/user-info-update', lastErrorAt: Date.now() })
      .where(eq(federationInstances.id, instanceId));

    const [owner] = await caller.federation.listInstances();
    expect(owner).toMatchObject({
      id: instanceId,
      pendingOutbox: 1,
      deadOutbox: 1,
      peerVersion: '0.3.0',
      lastError: 'unsupported:/federation/user-info-update'
    });

    const [active] = await caller.federation.listActiveInstances();
    expect(active).toMatchObject({
      id: instanceId,
      pendingOutbox: 1,
      deadOutbox: 1,
      lastError: 'unsupported:/federation/user-info-update'
    });
  });

  test('listDeadOutbox returns dead rows without payloads', async () => {
    const { caller } = await initTest(1);
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    await seedOutboxRows(instanceId);

    const dead = await caller.federation.listDeadOutbox({ instanceId });
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({
      path: '/federation/user-info-update',
      attempts: 1,
      lastError: 'unsupported:/federation/user-info-update'
    });
    expect(dead[0]).not.toHaveProperty('payload');
  });

  test('retryOutbox revives dead rows and a drain delivers them', async () => {
    const { caller } = await initTest(1);
    const instanceId = await seedPeerInstance(PEER_DOMAIN);
    await seedOutboxRows(instanceId);
    const sent: string[] = [];
    _setOutboxRelayForTests(async (_domain, path) => {
      sent.push(path);
      return { ok: true };
    });

    const result = await caller.federation.retryOutbox({ instanceId });
    expect(result.revived).toBe(1);
    await new Promise((r) => setTimeout(r, 100));

    expect(sent).toEqual(['/federation/user-info-update']);
    const remaining = await db.select().from(federationOutbox);
    // The pending row is not due yet; the revived one was delivered.
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.path).toBe('/federation/dm-relay');
  });

  test('the outbox routes are instance-owner only', async () => {
    const { caller } = await initTest(2);
    const instanceId = await seedPeerInstance(PEER_DOMAIN);

    await expect(caller.federation.retryOutbox({ instanceId })).rejects.toThrow('Only the instance owner');
    await expect(caller.federation.listDeadOutbox({ instanceId })).rejects.toThrow('Only the instance owner');
  });
});
