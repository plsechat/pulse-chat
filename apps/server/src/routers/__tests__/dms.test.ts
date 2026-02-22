import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';
import { dmChannels, dmMessages } from '../../db/schema';

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
});
