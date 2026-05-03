import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';
import {
  dmChannelMembers,
  dmChannels,
  dmE2eeSenderKeys,
  dmMessages
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
    const { caller: caller1 } = await initTest(1);
    await initTest(2);
    await initTest(3);
    const { caller: caller4 } = await initTest(4);

    const groupId = await makeGroup(1, [1, 2, 3]);

    await expect(
      caller4.dms.distributeSenderKeys({
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
    await initTest(4);

    const groupId = await makeGroup(1, [1, 2, 3]);

    // User 4 is not in the group — distribution to them must reject
    await expect(
      caller1.dms.distributeSenderKeys({
        dmChannelId: groupId,
        distributions: [
          { toUserId: 4, distributionMessage: 'leaked-cipher' }
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
