import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

describe('e2ee messages', () => {
  // --- Channel messages with E2EE ---

  test('should send an E2EE channel message', async () => {
    const { caller } = await initTest();

    // Enable E2EE on channel 1 first
    await caller.channels.update({
      channelId: 1,
      e2ee: true
    });

    await caller.messages.send({
      channelId: 1,
      encryptedContent: 'encrypted-payload-base64',
      e2ee: true
    });

    const result = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const msg = result.messages[0];
    expect(msg).toBeDefined();
    expect(msg!.e2ee).toBe(true);
    expect(msg!.encryptedContent).toBe('encrypted-payload-base64');
    expect(msg!.content).toBeNull();
  });

  test('should reject E2EE message without encryptedContent', async () => {
    const { caller } = await initTest();

    await expect(
      caller.messages.send({
        channelId: 1,
        e2ee: true
      })
    ).rejects.toThrow();
  });

  test('should reject plaintext message on E2EE channel', async () => {
    const { caller } = await initTest();

    await caller.channels.update({
      channelId: 1,
      e2ee: true
    });

    await expect(
      caller.messages.send({
        channelId: 1,
        content: 'plaintext message'
      })
    ).rejects.toThrow('This channel requires E2EE messages');
  });

  test('should edit an E2EE channel message with encryptedContent', async () => {
    const { caller } = await initTest();

    await caller.channels.update({
      channelId: 1,
      e2ee: true
    });

    await caller.messages.send({
      channelId: 1,
      encryptedContent: 'original-encrypted',
      e2ee: true
    });

    const before = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = before.messages[0]!.id;

    await caller.messages.edit({
      messageId,
      encryptedContent: 'updated-encrypted'
    });

    const after = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const edited = after.messages.find((m) => m.id === messageId);
    expect(edited!.encryptedContent).toBe('updated-encrypted');
    expect(edited!.content).toBeNull();
  });

  test('should exclude E2EE messages from search', async () => {
    const { caller } = await initTest();

    // Send a plaintext message
    await caller.messages.send({
      channelId: 1,
      content: 'findable plaintext message'
    });

    // Enable E2EE and send encrypted message
    await caller.channels.update({
      channelId: 1,
      e2ee: true
    });

    await caller.messages.send({
      channelId: 1,
      encryptedContent: 'encrypted-content',
      e2ee: true
    });

    // Search should only find the plaintext message
    const results = await caller.search.messages({
      query: 'findable'
    });

    expect(results.messages.length).toBe(1);
    expect(results.messages[0]!.content).toBe('findable plaintext message');
    expect(results.messages[0]!.e2ee).toBe(false);
  });

  // --- Channel E2EE flag ---

  test('should enable E2EE on a channel (owner only)', async () => {
    const { caller } = await initTest();

    await caller.channels.update({
      channelId: 1,
      e2ee: true
    });

    const channel = await caller.channels.get({ channelId: 1 });
    expect(channel.e2ee).toBe(true);
  });

  test('should not allow non-owner to enable E2EE', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.channels.update({
        channelId: 1,
        e2ee: true
      })
    ).rejects.toThrow();
  });

  test('should not allow disabling E2EE once enabled', async () => {
    const { caller } = await initTest();

    await caller.channels.update({
      channelId: 1,
      e2ee: true
    });

    await expect(
      caller.channels.update({
        channelId: 1,
        e2ee: false
      })
    ).rejects.toThrow('E2EE cannot be disabled once enabled');
  });

  // --- DM messages with E2EE ---

  test('should send an E2EE DM message', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    // Create a DM channel between user 1 and user 2
    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      encryptedContent: 'encrypted-dm-payload',
      e2ee: true
    });

    const result = await caller1.dms.getMessages({
      dmChannelId: channel.id
    });

    const msg = result.messages[0];
    expect(msg).toBeDefined();
    expect(msg!.e2ee).toBe(true);
    expect(msg!.encryptedContent).toBe('encrypted-dm-payload');
    expect(msg!.content).toBeNull();
  });

  test('should send a plaintext DM message', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    const channel = await caller1.dms.getOrCreateChannel({ userId: 2 });

    await caller1.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'hello plaintext'
    });

    const result = await caller1.dms.getMessages({
      dmChannelId: channel.id
    });

    const msg = result.messages[0];
    expect(msg!.e2ee).toBe(false);
    expect(msg!.content).toBe('hello plaintext');
    expect(msg!.encryptedContent).toBeNull();
  });

  test('should reject E2EE DM without encryptedContent', async () => {
    const { caller } = await initTest();

    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });

    await expect(
      caller.dms.sendMessage({
        dmChannelId: channel.id,
        e2ee: true
      })
    ).rejects.toThrow('E2EE messages must include encryptedContent');
  });

  test('should reject non-E2EE DM without content', async () => {
    const { caller } = await initTest();

    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });

    await expect(
      caller.dms.sendMessage({
        dmChannelId: channel.id
      })
    ).rejects.toThrow('Non-E2EE messages must include content');
  });

  test('should edit an E2EE DM message with encryptedContent', async () => {
    const { caller } = await initTest();

    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });

    await caller.dms.sendMessage({
      dmChannelId: channel.id,
      encryptedContent: 'original-encrypted-dm',
      e2ee: true
    });

    const before = await caller.dms.getMessages({
      dmChannelId: channel.id
    });

    const messageId = before.messages[0]!.id;

    await caller.dms.editMessage({
      messageId,
      encryptedContent: 'updated-encrypted-dm'
    });

    const after = await caller.dms.getMessages({
      dmChannelId: channel.id
    });

    const edited = after.messages.find((m) => m.id === messageId);
    expect(edited!.encryptedContent).toBe('updated-encrypted-dm');
    expect(edited!.edited).toBe(true);
  });

  test('should reject editing E2EE DM with plaintext content', async () => {
    const { caller } = await initTest();

    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });

    await caller.dms.sendMessage({
      dmChannelId: channel.id,
      encryptedContent: 'encrypted-dm',
      e2ee: true
    });

    const msgs = await caller.dms.getMessages({ dmChannelId: channel.id });
    const messageId = msgs.messages[0]!.id;

    await expect(
      caller.dms.editMessage({
        messageId,
        content: 'plaintext edit attempt'
      })
    ).rejects.toThrow('E2EE messages must be edited with encryptedContent');
  });

  test('should exclude E2EE DM messages from search', async () => {
    const { caller } = await initTest();

    const channel = await caller.dms.getOrCreateChannel({ userId: 2 });

    // Send plaintext DM
    await caller.dms.sendMessage({
      dmChannelId: channel.id,
      content: 'searchable dm message'
    });

    // Send E2EE DM
    await caller.dms.sendMessage({
      dmChannelId: channel.id,
      encryptedContent: 'encrypted-not-searchable',
      e2ee: true
    });

    const results = await caller.dms.searchMessages({
      query: 'searchable'
    });

    expect(results.messages.length).toBe(1);
    expect(results.messages[0]!.content).toBe('searchable dm message');
    expect(results.messages[0]!.e2ee).toBe(false);
  });

  // --- Channel E2EE with multiple users ---

  test('should allow multiple users to send E2EE messages in same channel', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.channels.update({ channelId: 1, e2ee: true });

    // User 1 sends E2EE message
    await caller1.messages.send({
      channelId: 1,
      encryptedContent: 'encrypted-from-user1',
      e2ee: true
    });

    // User 2 sends E2EE message
    await caller2.messages.send({
      channelId: 1,
      encryptedContent: 'encrypted-from-user2',
      e2ee: true
    });

    const result = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    // Filter to E2EE messages only (seed creates a plaintext message)
    const e2eeMessages = result.messages.filter((m) => m.e2ee);
    expect(e2eeMessages.length).toBe(2);
    expect(e2eeMessages.every((m) => m.content === null)).toBe(true);

    const fromUser1 = e2eeMessages.find((m) => m.userId === 1);
    const fromUser2 = e2eeMessages.find((m) => m.userId === 2);
    expect(fromUser1!.encryptedContent).toBe('encrypted-from-user1');
    expect(fromUser2!.encryptedContent).toBe('encrypted-from-user2');
  });

  test('should preserve E2EE flag on edited channel message', async () => {
    const { caller } = await initTest();

    await caller.channels.update({ channelId: 1, e2ee: true });

    await caller.messages.send({
      channelId: 1,
      encryptedContent: 'original-encrypted',
      e2ee: true
    });

    const before = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = before.messages[0]!.id;

    await caller.messages.edit({
      messageId,
      encryptedContent: 'updated-encrypted'
    });

    const after = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const edited = after.messages.find((m) => m.id === messageId);
    expect(edited!.e2ee).toBe(true);
    expect(edited!.encryptedContent).toBe('updated-encrypted');
    expect(edited!.content).toBeNull();
    expect(edited!.edited).toBe(true);
  });

  test('should reject editing E2EE channel message with plaintext', async () => {
    const { caller } = await initTest();

    await caller.channels.update({ channelId: 1, e2ee: true });

    await caller.messages.send({
      channelId: 1,
      encryptedContent: 'encrypted-payload',
      e2ee: true
    });

    const result = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = result.messages[0]!.id;

    await expect(
      caller.messages.edit({
        messageId,
        content: 'plaintext edit attempt'
      })
    ).rejects.toThrow('E2EE messages must be edited with encryptedContent');
  });
});
