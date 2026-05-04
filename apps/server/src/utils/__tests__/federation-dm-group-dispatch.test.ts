/**
 * Phase D / D2 — federation-dm-group-dispatch unit tests.
 *
 * Covers the pure-DB helpers that decide whether and how to relay
 * group DM lifecycle events to peer instances. Network-side
 * (`relayToInstance`) is fire-and-forget; tested elsewhere.
 *
 *   - `assignFederationGroupIdIfNeeded` — assigns a UUID when a
 *     group has any federated member; returns null otherwise; is
 *     idempotent.
 *   - `buildFederatedMemberList` — returns the wire-shape member
 *     list with correct local-vs-federated domain attribution and
 *     a complete set of peer domains.
 *
 * Setup is done inside each test rather than in beforeEach. Following
 * the federation-membership.test.ts pattern: avoids piling rows onto
 * the shared CI postgres in a beforeEach hook that competes with
 * other test files' TRUNCATE in setup.ts and triggers cross-file
 * deadlock timeouts (see pulse-build-bun-stale-symlinks +
 * federation-rate-limit notes for the same class of issue).
 */

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  federationInstances,
  users
} from '../../db/schema';
import { config } from '../../config';
import {
  assignFederationGroupIdIfNeeded,
  buildFederatedMemberList
} from '../federation-dm-group-dispatch';

const PEER_DOMAIN_A = 'peer-a.example';
const PEER_DOMAIN_B = 'peer-b.example';

/**
 * Seed two federation peers and two shadow users, returning their
 * ids. Local user 1 is provided by the global seed.ts setup.
 */
async function seedFederatedScenario() {
  const [instA] = await db
    .insert(federationInstances)
    .values({
      domain: PEER_DOMAIN_A,
      name: 'Peer A',
      status: 'active',
      direction: 'outgoing',
      createdAt: Date.now()
    })
    .returning();

  const [instB] = await db
    .insert(federationInstances)
    .values({
      domain: PEER_DOMAIN_B,
      name: 'Peer B',
      status: 'active',
      direction: 'outgoing',
      createdAt: Date.now()
    })
    .returning();

  const [fedA] = await db
    .insert(users)
    .values({
      supabaseId: 'fed-a-uuid',
      name: 'fedAlice',
      publicId: 'fed-a-public',
      isFederated: true,
      federatedInstanceId: instA!.id,
      federatedPublicId: 'remote-a-pid',
      createdAt: Date.now()
    })
    .returning();

  const [fedB] = await db
    .insert(users)
    .values({
      supabaseId: 'fed-b-uuid',
      name: 'fedBob',
      publicId: 'fed-b-public',
      isFederated: true,
      federatedInstanceId: instB!.id,
      federatedPublicId: 'remote-b-pid',
      createdAt: Date.now()
    })
    .returning();

  return {
    localUserId: 1,
    federatedUserAId: fedA!.id,
    federatedUserBId: fedB!.id,
    instAId: instA!.id,
    instBId: instB!.id
  };
}

async function createChannel(args: {
  isGroup: boolean;
  memberIds: number[];
  federationGroupId?: string | null;
}): Promise<number> {
  const [channel] = await db
    .insert(dmChannels)
    .values({
      isGroup: args.isGroup,
      federationGroupId: args.federationGroupId ?? null,
      createdAt: Date.now()
    })
    .returning();
  await db.insert(dmChannelMembers).values(
    args.memberIds.map((userId) => ({
      dmChannelId: channel!.id,
      userId,
      createdAt: Date.now()
    }))
  );
  return channel!.id;
}

describe('assignFederationGroupIdIfNeeded', () => {
  test('returns null for a same-instance group', async () => {
    const { localUserId } = await seedFederatedScenario();
    const channelId = await createChannel({
      isGroup: true,
      memberIds: [localUserId]
    });
    const result = await assignFederationGroupIdIfNeeded(channelId);
    expect(result).toBeNull();
    const [row] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channelId));
    expect(row?.federationGroupId).toBeNull();
  });

  test('returns null for a 1:1 channel even with a federated member', async () => {
    // 1:1 channels never get a federationGroupId — Phase D / D2 only
    // applies to groups (the column is null for 1:1s by design).
    const { localUserId, federatedUserAId } = await seedFederatedScenario();
    const channelId = await createChannel({
      isGroup: false,
      memberIds: [localUserId, federatedUserAId]
    });
    const result = await assignFederationGroupIdIfNeeded(channelId);
    expect(result).toBeNull();
  });

  test('assigns a UUID when a group includes any federated member', async () => {
    const { localUserId, federatedUserAId } = await seedFederatedScenario();
    const channelId = await createChannel({
      isGroup: true,
      memberIds: [localUserId, federatedUserAId]
    });
    const result = await assignFederationGroupIdIfNeeded(channelId);
    expect(result).not.toBeNull();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);

    // The id is persisted to the row.
    const [row] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channelId));
    expect(row?.federationGroupId).toBe(result);
  });

  test('is idempotent — a second call returns the same value', async () => {
    const { localUserId, federatedUserAId } = await seedFederatedScenario();
    const channelId = await createChannel({
      isGroup: true,
      memberIds: [localUserId, federatedUserAId]
    });
    const first = await assignFederationGroupIdIfNeeded(channelId);
    const second = await assignFederationGroupIdIfNeeded(channelId);
    expect(second).toBe(first);
  });
});

describe('buildFederatedMemberList', () => {
  test('attributes local users to our domain and federated users to their home', async () => {
    const { localUserId, federatedUserAId, federatedUserBId } =
      await seedFederatedScenario();
    const channelId = await createChannel({
      isGroup: true,
      memberIds: [localUserId, federatedUserAId, federatedUserBId]
    });
    const { members, peerDomains } = await buildFederatedMemberList(channelId);

    expect(members).toHaveLength(3);
    const localMember = members.find(
      (m) => m.instanceDomain === config.federation.domain
    );
    expect(localMember).toBeDefined();

    const aMember = members.find((m) => m.instanceDomain === PEER_DOMAIN_A);
    expect(aMember).toBeDefined();
    expect(aMember!.publicId).toBe('remote-a-pid');

    const bMember = members.find((m) => m.instanceDomain === PEER_DOMAIN_B);
    expect(bMember).toBeDefined();
    expect(bMember!.publicId).toBe('remote-b-pid');

    expect(peerDomains.has(PEER_DOMAIN_A)).toBe(true);
    expect(peerDomains.has(PEER_DOMAIN_B)).toBe(true);
    expect(peerDomains.size).toBe(2);
  });

  test('returns the federated public id (not the local shadow publicId)', async () => {
    // The shadow user has `publicId` (assigned by the local instance)
    // and `federatedPublicId` (the user's id at their home). The
    // wire-shape member descriptor has to use the federated one so
    // peers can match.
    const { federatedUserAId } = await seedFederatedScenario();
    const channelId = await createChannel({
      isGroup: true,
      memberIds: [federatedUserAId]
    });
    const { members } = await buildFederatedMemberList(channelId);
    const fedA = members.find((m) => m.instanceDomain === PEER_DOMAIN_A);
    expect(fedA!.publicId).toBe('remote-a-pid');
    expect(fedA!.publicId).not.toBe('fed-a-public');
  });

  test('peerDomains is empty for an all-local group', async () => {
    const { localUserId } = await seedFederatedScenario();
    const channelId = await createChannel({
      isGroup: true,
      memberIds: [localUserId]
    });
    const { peerDomains } = await buildFederatedMemberList(channelId);
    expect(peerDomains.size).toBe(0);
  });
});
