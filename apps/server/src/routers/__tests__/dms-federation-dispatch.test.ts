/**
 * Phase D — server-side dispatch integration tests.
 *
 * Tests that the existing dms/* tRPC routes trigger the right
 * federation side-effects:
 *
 *   - dms.createGroup assigns a federationGroupId iff a member is
 *     federated; leaves it null for all-local groups.
 *   - dms.addMember promoting a 1:1 with a federated user assigns
 *     a federationGroupId on the fly (the channel didn't have one
 *     while it was 1:1).
 *   - dms.removeMember preserves the federationGroupId (the
 *     channel still federates after a removal).
 *   - dms.distributeSenderKeys writes only LOCAL recipients' SKDMs
 *     to dm_e2ee_sender_keys; federated recipients get relayed
 *     fire-and-forget (no local row).
 *
 * Network-side (`relayToInstance`) is fire-and-forget — these
 * tests don't intercept the call, just verify the local DB state
 * after the route completes.
 *
 * Inline setup (no beforeEach) per the cross-file deadlock
 * mitigation pattern.
 */

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  dmE2eeSenderKeys,
  federationInstances,
  friendships,
  users
} from '../../db/schema';
import { initTest } from '../../__tests__/helpers';

const PEER_DOMAIN = 'peer.dispatch.example';

async function seedFederatedFriend(): Promise<number> {
  const [instance] = await db
    .insert(federationInstances)
    .values({
      domain: PEER_DOMAIN,
      name: 'Dispatch Peer',
      status: 'active',
      direction: 'outgoing',
      publicKey: '{"kty":"OKP","crv":"Ed25519","x":"placeholder"}',
      createdAt: Date.now()
    })
    .returning();

  const [federated] = await db
    .insert(users)
    .values({
      supabaseId: 'fed-friend-uuid',
      name: 'fedFriend',
      publicId: 'fed-friend-pid',
      isFederated: true,
      federatedInstanceId: instance!.id,
      federatedPublicId: 'remote-friend-pid',
      createdAt: Date.now()
    })
    .returning();

  // dms.createGroup requires friendship between caller and members.
  await db.insert(friendships).values({
    userId: 1,
    friendId: federated!.id,
    createdAt: Date.now()
  });

  return federated!.id;
}

async function seedLocalFriend(): Promise<number> {
  const [local] = await db
    .insert(users)
    .values({
      supabaseId: 'local-friend-uuid',
      name: 'localFriend',
      publicId: 'local-friend-pid',
      isFederated: false,
      createdAt: Date.now()
    })
    .returning();

  await db.insert(friendships).values({
    userId: 1,
    friendId: local!.id,
    createdAt: Date.now()
  });

  return local!.id;
}

describe('dms.createGroup federation dispatch (D2)', () => {
  test('all-local group leaves federationGroupId null', async () => {
    const { caller } = await initTest(1);
    const localFriend = await seedLocalFriend();

    const channel = await caller.dms.createGroup({
      userIds: [localFriend],
      name: 'Local Only'
    });

    const [row] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(row?.federationGroupId).toBeNull();
  });

  test('group with a federated member gets a federationGroupId', async () => {
    const { caller } = await initTest(1);
    const fedFriend = await seedFederatedFriend();

    const channel = await caller.dms.createGroup({
      userIds: [fedFriend],
      name: 'Mixed Group'
    });

    const [row] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(row?.federationGroupId).not.toBeNull();
    expect(typeof row?.federationGroupId).toBe('string');
    expect(row!.federationGroupId!.length).toBeGreaterThan(0);
  });
});

describe('dms.addMember federation dispatch (D2)', () => {
  test('1:1 → group promotion that adds a federated member assigns a federationGroupId', async () => {
    const { caller } = await initTest(1);
    const localFriend = await seedLocalFriend();
    const fedFriend = await seedFederatedFriend();

    // Start with a 1:1 channel between user 1 and the local friend.
    // Use getOrCreateChannel to get the same shape as the real flow.
    const oneToOne = await caller.dms.getOrCreateChannel({
      userId: localFriend
    });

    // Pre-promotion: federationGroupId is null.
    const [pre] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, oneToOne.id))
      .limit(1);
    expect(pre?.federationGroupId).toBeNull();

    await caller.dms.addMember({
      dmChannelId: oneToOne.id,
      userIds: [fedFriend]
    });

    // Post-promotion: channel is now a group AND has a
    // federationGroupId because a federated member was added.
    const [post] = await db
      .select({
        isGroup: dmChannels.isGroup,
        federationGroupId: dmChannels.federationGroupId
      })
      .from(dmChannels)
      .where(eq(dmChannels.id, oneToOne.id))
      .limit(1);
    expect(post?.isGroup).toBe(true);
    expect(post?.federationGroupId).not.toBeNull();
    expect(typeof post?.federationGroupId).toBe('string');
  });

  test('adding to an existing federated group keeps the same federationGroupId', async () => {
    const { caller } = await initTest(1);
    const fedFriend1 = await seedFederatedFriend();
    const localFriend = await seedLocalFriend();

    const channel = await caller.dms.createGroup({
      userIds: [fedFriend1],
      name: 'Existing Federated Group'
    });

    const [pre] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    const originalId = pre!.federationGroupId;
    expect(originalId).not.toBeNull();

    await caller.dms.addMember({
      dmChannelId: channel.id,
      userIds: [localFriend]
    });

    const [post] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(post?.federationGroupId).toBe(originalId);
  });
});

describe('dms.removeMember federation dispatch (D2)', () => {
  test('removing a member preserves the federationGroupId', async () => {
    const { caller } = await initTest(1);
    const fedFriend = await seedFederatedFriend();
    const localFriend = await seedLocalFriend();

    const channel = await caller.dms.createGroup({
      userIds: [fedFriend, localFriend],
      name: 'Remove Test'
    });

    const [pre] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    const originalId = pre!.federationGroupId;

    await caller.dms.removeMember({
      dmChannelId: channel.id,
      userId: localFriend
    });

    const [post] = await db
      .select({ federationGroupId: dmChannels.federationGroupId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(post?.federationGroupId).toBe(originalId);

    const remaining = await db
      .select()
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, channel.id));
    // Owner (1) + federated friend remain.
    expect(remaining).toHaveLength(2);
  });
});

describe('dms.distributeSenderKeys federation split (D2)', () => {
  test('writes only local-recipient SKDMs to dm_e2ee_sender_keys; federated recipients are not stored locally', async () => {
    const { caller } = await initTest(1);
    const fedFriend = await seedFederatedFriend();
    const localFriend = await seedLocalFriend();

    const channel = await caller.dms.createGroup({
      userIds: [fedFriend, localFriend],
      name: 'SKDM Split'
    });

    await caller.dms.distributeSenderKeys({
      dmChannelId: channel.id,
      senderKeyId: 1,
      distributions: [
        { toUserId: localFriend, distributionMessage: 'skdm-for-local' },
        { toUserId: fedFriend, distributionMessage: 'skdm-for-fed' }
      ]
    });

    const rows = await db
      .select()
      .from(dmE2eeSenderKeys)
      .where(eq(dmE2eeSenderKeys.dmChannelId, channel.id));

    // Only one row — the local recipient's. The federated one was
    // relayed fire-and-forget and doesn't persist on this side.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.toUserId).toBe(localFriend);
    expect(rows[0]!.distributionMessage).toBe('skdm-for-local');
  });
});
