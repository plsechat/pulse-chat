import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { createTestUser } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import {
  dmChannelMembers,
  dmChannels,
  dmE2eeSenderKeys,
  dmMessages,
  friendships
} from '../../db/schema';

// Build a 3-person group DM directly in the DB so tests don't have to
// set up friendships (createGroup gates on friendship — orthogonal to
// the sender-key routes under test here).
async function makeGroup(
  ownerId: number,
  memberIds: number[]
): Promise<number> {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(dmChannels)
    .values({
      ownerId,
      isGroup: true,
      e2ee: true,
      createdAt: now
    })
    .returning();
  await tdb.insert(dmChannelMembers).values(
    memberIds.map((userId) => ({
      dmChannelId: row!.id,
      userId,
      createdAt: now
    }))
  );
  return row!.id;
}

describe('DM delete channel', () => {
  test('deletes a DM channel and cascades messages', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);

    // Create a DM channel between user 1 and 2
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    expect(channel).toBeDefined();

    // Send a message
    await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'Hello from user 1'
    });

    // Verify message exists
    const msgs = await caller1.dms.getMessages({ dmChannelId: channel.id });
    expect(msgs.messages.length).toBeGreaterThan(0);

    // Delete the channel
    await caller1.dms.deleteChannel({ dmChannelId: channel.id });

    // Verify channel is gone
    const tdb = getTestDb();
    const [row] = await tdb
      .select()
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(row).toBeUndefined();

    // Verify messages are cascaded
    const [msgRow] = await tdb
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.dmChannelId, channel.id))
      .limit(1);
    expect(msgRow).toBeUndefined();
  });

  test('rejects non-member delete', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller3 } = await initTest(3);

    // Create a DM between user 1 and 2
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    // User 3 should not be able to delete
    await expect(
      caller3.dms.deleteChannel({ dmChannelId: channel.id })
    ).rejects.toThrow();
  });
});

describe('DM enable encryption', () => {
  test('enables encryption on unencrypted channel', async () => {
    const { caller: caller1 } = await initTest(1);

    // Create a DM channel (defaults to e2ee=false now)
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    expect(channel.e2ee).toBe(false);

    // Enable encryption
    const result = await caller1.dms.enableEncryption({
      dmChannelId: channel.id
    });
    expect(result.e2ee).toBe(true);

    // Verify via DB
    const tdb = getTestDb();
    const [row] = await tdb
      .select({ e2ee: dmChannels.e2ee })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(row?.e2ee).toBe(true);
  });

  test('no-ops on already-encrypted channel', async () => {
    const { caller: caller1 } = await initTest(1);

    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    // Enable encryption first
    await caller1.dms.enableEncryption({ dmChannelId: channel.id });

    // Enable again — should be a no-op, not throw
    const result = await caller1.dms.enableEncryption({
      dmChannelId: channel.id
    });
    expect(result.e2ee).toBe(true);
  });

  test('rejects non-member encryption enable', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller3 } = await initTest(3);

    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    await expect(
      caller3.dms.enableEncryption({ dmChannelId: channel.id })
    ).rejects.toThrow();
  });

  test('rejects plaintext send on encrypted channel', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);

    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    await caller1.dms.enableEncryption({ dmChannelId: channel.id });

    // Plaintext send (e2ee flag missing or false) must be rejected.
    // This is the safety net that closed the silent-plaintext bug class:
    // any client sending without e2ee=true on an encrypted channel
    // gets a loud error rather than landing cleartext in the DB.
    await expect(
      caller1.dms.sendMessage({
        dmChannelId: channel.id,
        content: 'plaintext'
      })
    ).rejects.toThrow();

    // Verify the DB has no leaked plaintext row.
    const tdb = getTestDb();
    const rows = await tdb
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.dmChannelId, channel.id));
    expect(rows.length).toBe(0);
  });

  test('rejects encrypted send on unencrypted channel', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);

    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    // Channel was never encrypted (e2ee=false). Sending with e2ee=true
    // is a contract violation — reject so the client surfaces it.
    await expect(
      caller1.dms.sendMessage({
        dmChannelId: channel.id,
        content: 'fake-ciphertext',
        e2ee: true
      })
    ).rejects.toThrow();
  });
});

describe('DM group sender-key distribution', () => {
  test('member can distribute, recipient can fetch and ack', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);

    // Create a 3-person group DM
    const groupId = await makeGroup(1, [1, 2, 3]);

    // User 1 distributes their sender key to users 2 and 3
    await caller1.dms.distributeSenderKeys({
      dmChannelId: groupId,
      distributions: [
        { toUserId: 2, distributionMessage: 'opaque-cipher-for-2' },
        { toUserId: 3, distributionMessage: 'opaque-cipher-for-3' }
      ]
    });

    // User 2 sees their pending key
    const pending2 = await caller2.dms.getPendingSenderKeys({});
    expect(pending2.length).toBe(1);
    expect(pending2[0]!.fromUserId).toBe(1);
    expect(pending2[0]!.dmChannelId).toBe(groupId);
    expect(pending2[0]!.distributionMessage).toBe('opaque-cipher-for-2');

    // User 3 sees their pending key (not user 2's)
    const pending3 = await caller3.dms.getPendingSenderKeys({});
    expect(pending3.length).toBe(1);
    expect(pending3[0]!.distributionMessage).toBe('opaque-cipher-for-3');

    // User 2 acknowledges and the row is gone
    await caller2.dms.acknowledgeSenderKeys({ ids: [pending2[0]!.id] });
    const after = await caller2.dms.getPendingSenderKeys({});
    expect(after.length).toBe(0);

    // User 3's pending row remains untouched
    const tdb = getTestDb();
    const stillThere = await tdb
      .select()
      .from(dmE2eeSenderKeys)
      .where(
        and(
          eq(dmE2eeSenderKeys.dmChannelId, groupId),
          eq(dmE2eeSenderKeys.toUserId, 3)
        )
      );
    expect(stillThere.length).toBe(1);
  });

  test('rejects distribute when caller is not a group member', async () => {
    await initTest(1);
    await initTest(2);
    await initTest(3);
    // Seed only creates users 1-3. Insert a fourth so initTest(outsiderId)
    // can build a caller context for them.
    const outsiderId = await createTestUser({ name: 'Outsider' });
    const { caller: outsider } = await initTest(outsiderId);

    const groupId = await makeGroup(1, [1, 2, 3]);

    await expect(
      outsider.dms.distributeSenderKeys({
        dmChannelId: groupId,
        distributions: [
          { toUserId: 2, distributionMessage: 'should not land' }
        ]
      })
    ).rejects.toThrow();
  });

  test('rejects distribute when recipient is not a group member', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    const outsiderId = await createTestUser({ name: 'Outsider' });

    const groupId = await makeGroup(1, [1, 2, 3]);

    // outsiderId is not in the group — distribution to them must reject.
    // (The route's membership check fires before the insert, so the user
    // existing or not is irrelevant; we create the user anyway for
    // realism since FK would reject otherwise on a successful path.)
    await expect(
      caller1.dms.distributeSenderKeys({
        dmChannelId: groupId,
        distributions: [
          { toUserId: outsiderId, distributionMessage: 'leaked-cipher' }
        ]
      })
    ).rejects.toThrow();
  });

  test('acknowledge only deletes own pending rows', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const { caller: caller3 } = await initTest(3);

    const groupId = await makeGroup(1, [1, 2, 3]);

    await caller1.dms.distributeSenderKeys({
      dmChannelId: groupId,
      distributions: [
        { toUserId: 2, distributionMessage: 'cipher-2' },
        { toUserId: 3, distributionMessage: 'cipher-3' }
      ]
    });

    const pending3 = await caller3.dms.getPendingSenderKeys({});
    const id3 = pending3[0]!.id;

    // User 2 tries to ack user 3's row by id — must be a no-op
    await caller2.dms.acknowledgeSenderKeys({ ids: [id3] });

    // Row still exists for user 3
    const after = await caller3.dms.getPendingSenderKeys({});
    expect(after.length).toBe(1);
    expect(after[0]!.id).toBe(id3);
  });
});

// addMember covers two flows in one route: adding to an existing
// group (owner-gated, batched) and promoting a 1:1 to a group (any
// member can promote, caller becomes owner). Both gates the friend
// requirement.
async function makeFriendship(userIdA: number, userIdB: number) {
  const tdb = getTestDb();
  await tdb.insert(friendships).values({
    userId: userIdA,
    friendId: userIdB,
    createdAt: Date.now()
  });
}

describe('DM addMember', () => {
  test('group owner can add a single friend', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);

    const groupId = await makeGroup(1, [1, 2]);
    await makeFriendship(1, 3);

    await caller1.dms.addMember({ dmChannelId: groupId, userIds: [3] });

    const tdb = getTestDb();
    const members = await tdb
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, groupId));
    const ids = members.map((m) => m.userId).sort();
    expect(ids).toEqual([1, 2, 3]);
  });

  test('group owner can add multiple friends in one call', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    const fourthId = await createTestUser({ name: 'Fourth' });
    await initTest(fourthId);

    const groupId = await makeGroup(1, [1, 2]);
    await makeFriendship(1, 3);
    await makeFriendship(1, fourthId);

    await caller1.dms.addMember({
      dmChannelId: groupId,
      userIds: [3, fourthId]
    });

    const tdb = getTestDb();
    const members = await tdb
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, groupId));
    expect(members.length).toBe(4);
  });

  test('non-owner cannot add to an existing group', async () => {
    await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);

    // makeGroup sets ownerId=1
    const groupId = await makeGroup(1, [1, 2]);
    await makeFriendship(2, 3);

    await expect(
      caller2.dms.addMember({ dmChannelId: groupId, userIds: [3] })
    ).rejects.toThrow();
  });

  test('rejects adding a non-friend', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);

    const groupId = await makeGroup(1, [1, 2]);
    // No friendship between 1 and 3

    await expect(
      caller1.dms.addMember({ dmChannelId: groupId, userIds: [3] })
    ).rejects.toThrow();
  });

  test('rejects when all picks are already members', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);

    const groupId = await makeGroup(1, [1, 2]);
    await makeFriendship(1, 2);

    // 2 is already a member; nothing to do
    await expect(
      caller1.dms.addMember({ dmChannelId: groupId, userIds: [2] })
    ).rejects.toThrow();
  });

  test('rejects when adding would exceed the 10-member cap', async () => {
    const { caller: caller1 } = await initTest(1);
    // Build a group already at 10 members
    const otherIds: number[] = [];
    for (let i = 0; i < 9; i++) {
      const uid = await createTestUser({ name: `Filler${i}` });
      otherIds.push(uid);
    }
    const groupId = await makeGroup(1, [1, ...otherIds]);
    const newId = await createTestUser({ name: 'OneTooMany' });
    await makeFriendship(1, newId);

    await expect(
      caller1.dms.addMember({ dmChannelId: groupId, userIds: [newId] })
    ).rejects.toThrow();
  });

  test('promotes a 1:1 to a group when adding a third member', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);

    // Real 1:1 channel via getOrCreateChannel so isGroup=false
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    expect(channel.isGroup).toBe(false);

    await makeFriendship(1, 3);

    await caller1.dms.addMember({
      dmChannelId: channel.id,
      userIds: [3]
    });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ isGroup: dmChannels.isGroup, ownerId: dmChannels.ownerId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(row?.isGroup).toBe(true);
    // Promoter becomes owner
    expect(row?.ownerId).toBe(1);

    const members = await tdb
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, channel.id));
    expect(members.length).toBe(3);
  });

  test('any member of a 1:1 can promote (owner gate is group-only)', async () => {
    await initTest(1);
    const { caller: caller2 } = await initTest(2);
    await initTest(3);

    // 1:1 originated by user 1, but 2 should be able to promote
    const { caller: caller1 } = await initTest(1);
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });
    expect(channel.isGroup).toBe(false);

    await makeFriendship(2, 3);

    await caller2.dms.addMember({
      dmChannelId: channel.id,
      userIds: [3]
    });

    const tdb = getTestDb();
    const [row] = await tdb
      .select({ isGroup: dmChannels.isGroup, ownerId: dmChannels.ownerId })
      .from(dmChannels)
      .where(eq(dmChannels.id, channel.id))
      .limit(1);
    expect(row?.isGroup).toBe(true);
    // 2 promoted, so 2 is owner of the resulting group
    expect(row?.ownerId).toBe(2);
  });
});

// declineCall is a pure notification mutation — no persisted state,
// just publishes DM_CALL_DECLINED. Server-side test coverage is
// limited to membership gating; the client-side toast + auto-leave
// behavior is exercised manually.
describe('DM declineCall', () => {
  test('member can decline a call in their channel', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);

    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    // Just resolves — the route returns void after publishing.
    await expect(
      caller1.dms.declineCall({ dmChannelId: channel.id })
    ).resolves.toBeUndefined();
  });

  test('non-member cannot decline a call in someone else\'s channel', async () => {
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    const { caller: caller3 } = await initTest(3);

    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    await expect(
      caller3.dms.declineCall({ dmChannelId: channel.id })
    ).rejects.toThrow();
  });
});
