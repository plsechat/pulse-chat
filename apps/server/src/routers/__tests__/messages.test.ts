import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

describe('messages router', () => {
  test('should throw when user lacks permissions (edit - not own message)', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.messages.send({
      channelId: 1,
      content: 'Original message',
      files: []
    });

    const messages = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await expect(
      caller2.messages.edit({
        messageId,
        content: 'Edited message'
      })
    ).rejects.toThrow('You do not have permission to edit this message');
  });

  test('should throw when user lacks permissions (delete - not own message)', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.messages.send({
      channelId: 1,
      content: 'Message to delete',
      files: []
    });

    const messages = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await expect(
      caller2.messages.delete({
        messageId
      })
    ).rejects.toThrow('You do not have permission to delete this message');
  });

  test.skip('should throw when user lacks permissions (toggleReaction)', async () => {
    // TODO: user 2 has REACT_TO_MESSAGES via default Member role, so this test is incorrect
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.messages.send({
      channelId: 1,
      content: 'Message to react to',
      files: []
    });

    const messages = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await expect(
      caller2.messages.toggleReaction({
        messageId,
        emoji: '👍'
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should send a new message', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 1,
      content: 'Test message content',
      files: []
    });

    const messages = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    expect(messages.messages).toBeDefined();
    expect(messages.messages.length).toBeGreaterThan(0);

    const sentMessage = messages.messages[0];

    expect(sentMessage!.content).toBe('Test message content');
    expect(sentMessage!.channelId).toBe(1);
    expect(sentMessage!.userId).toBe(1);
  });

  test('should get messages from channel', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 2,
      content: 'Message 1',
      files: []
    });

    await caller.messages.send({
      channelId: 2,
      content: 'Message 2',
      files: []
    });

    await caller.messages.send({
      channelId: 2,
      content: 'Message 3',
      files: []
    });

    const result = await caller.messages.get({
      channelId: 2,
      cursor: null,
      limit: 50
    });

    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBe(3);
  });

  test('should edit own message', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 1,
      content: 'Original content',
      files: []
    });

    const messagesBefore = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messagesBefore.messages[0]!.id;

    await caller.messages.edit({
      messageId,
      content: 'Edited content'
    });

    const messagesAfter = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const editedMessage = messagesAfter.messages.find(
      (m) => m.id === messageId
    );

    expect(editedMessage).toBeDefined();
    expect(editedMessage!.content).toBe('Edited content');
    expect(editedMessage!.updatedAt).toBeDefined();
    expect(editedMessage!.updatedAt).not.toBeNull();
  });

  test('should not allow admin to edit another users message', async () => {
    const { caller: caller2 } = await initTest(2);
    const { caller: caller1 } = await initTest(1);

    await caller2.messages.send({
      channelId: 1,
      content: 'User 2 message',
      files: []
    });

    const messages = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await expect(
      caller1.messages.edit({
        messageId,
        content: 'Edited by admin'
      })
    ).rejects.toThrow('You do not have permission to edit this message');
  });

  test('should delete own message', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 1,
      content: 'Message to delete',
      files: []
    });

    const messagesBefore = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messagesBefore.messages[0]!.id;
    const messageCountBefore = messagesBefore.messages.length;

    await caller.messages.delete({
      messageId
    });

    const messagesAfter = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    expect(
      messagesAfter.messages.find((m) => m.id === messageId)
    ).toBeUndefined();
    expect(messagesAfter.messages.length).toBe(messageCountBefore - 1);
  });

  test('should allow admin to delete any message', async () => {
    const { caller: caller2 } = await initTest(2);
    const { caller: caller1 } = await initTest(1);

    await caller2.messages.send({
      channelId: 1,
      content: 'User 2 message to delete',
      files: []
    });

    const messages = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await caller1.messages.delete({
      messageId
    });

    const messagesAfter = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    expect(
      messagesAfter.messages.find((m) => m.id === messageId)
    ).toBeUndefined();
  });

  test('should throw when editing non-existing message', async () => {
    const { caller } = await initTest();

    await expect(
      caller.messages.edit({
        messageId: 999999,
        content: 'Edited content'
      })
    ).rejects.toThrow('Message not found');
  });

  test('should throw when deleting non-existing message', async () => {
    const { caller } = await initTest();

    await expect(
      caller.messages.delete({
        messageId: 999999
      })
    ).rejects.toThrow('Message not found');
  });

  test('should toggle reaction on message', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 1,
      content: 'Message to react to',
      files: []
    });

    const messages = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await caller.messages.toggleReaction({
      messageId,
      emoji: '👍'
    });

    const messagesAfterAdd = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageWithReaction = messagesAfterAdd.messages.find(
      (m) => m.id === messageId
    );

    expect(messageWithReaction!.reactions).toBeDefined();
    expect(messageWithReaction!.reactions.length).toBe(1);
    expect(messageWithReaction!.reactions[0]!.emoji).toBe('👍');
    expect(messageWithReaction!.reactions[0]!.userId).toBe(1);

    await caller.messages.toggleReaction({
      messageId,
      emoji: '👍'
    });

    const messagesAfterRemove = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageWithoutReaction = messagesAfterRemove.messages.find(
      (m) => m.id === messageId
    );

    expect(messageWithoutReaction!.reactions.length).toBe(0);
  });

  test('should allow multiple users to react to the same message', async () => {
    const { caller: caller1 } = await initTest(1);

    await caller1.messages.send({
      channelId: 1,
      content: 'Message for multiple reactions',
      files: []
    });

    const messages = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await caller1.messages.toggleReaction({
      messageId,
      emoji: '👍'
    });

    await caller1.messages.toggleReaction({
      messageId,
      emoji: '❤️'
    });

    const messagesAfter = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageWithReactions = messagesAfter.messages.find(
      (m) => m.id === messageId
    );

    expect(messageWithReactions!.reactions.length).toBe(2);

    const emojis = messageWithReactions!.reactions.map((r) => r.emoji);

    expect(emojis).toContain('👍');
    expect(emojis).toContain('❤️');
  });

  test('should allow multiple different reactions on the same message', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 1,
      content: 'Message for different reactions',
      files: []
    });

    const messages = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messages.messages[0]!.id;

    await caller.messages.toggleReaction({
      messageId,
      emoji: '👍'
    });

    await caller.messages.toggleReaction({
      messageId,
      emoji: '❤️'
    });

    await caller.messages.toggleReaction({
      messageId,
      emoji: '😂'
    });

    const messagesAfter = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageWithReactions = messagesAfter.messages.find(
      (m) => m.id === messageId
    );

    expect(messageWithReactions!.reactions.length).toBe(3);

    const emojis = messageWithReactions!.reactions.map((r) => r.emoji);

    expect(emojis).toContain('👍');
    expect(emojis).toContain('❤️');
    expect(emojis).toContain('😂');
  });

  test('should send multiple messages', async () => {
    const { caller } = await initTest();

    const messageCount = 5;
    const promises = [];

    for (let i = 0; i < messageCount; i++) {
      promises.push(
        caller.messages.send({
          channelId: 2,
          content: `Message ${i + 1}`,
          files: []
        })
      );
    }

    await Promise.all(promises);

    const messages = await caller.messages.get({
      channelId: 2,
      cursor: null,
      limit: 50
    });

    expect(messages.messages.length).toBe(messageCount);
  });

  test('should signal typing in channel', async () => {
    const { caller } = await initTest();

    await caller.messages.signalTyping({
      channelId: 1
    });
  });

  test('should paginate messages with cursor', async () => {
    const { caller } = await initTest();

    // send 10 messages
    for (let i = 0; i < 10; i++) {
      await caller.messages.send({
        channelId: 1,
        content: `Message ${i + 1}`,
        files: []
      });
    }

    // get first page
    const firstPage = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 5
    });

    expect(firstPage.messages.length).toBe(5);
    expect(firstPage.nextCursor).toBeDefined();
    expect(firstPage.nextCursor).not.toBeNull();

    // get second page
    const secondPage = await caller.messages.get({
      channelId: 1,
      cursor: firstPage.nextCursor,
      limit: 5
    });

    expect(secondPage.messages.length).toBeGreaterThan(0);

    // ensure no overlap between pages
    const firstPageIds = firstPage.messages.map((m) => m.id);
    const secondPageIds = secondPage.messages.map((m) => m.id);

    const intersection = firstPageIds.filter((id) =>
      secondPageIds.includes(id)
    );

    expect(intersection.length).toBe(0);
  });

  test('should return empty messages for empty channel', async () => {
    const { caller } = await initTest();

    const messages = await caller.messages.get({
      channelId: 2,
      cursor: null,
      limit: 50
    });

    expect(messages.messages).toBeDefined();
    expect(Array.isArray(messages.messages)).toBe(true);
    expect(messages.nextCursor).toBeNull();
  });

  test('should send message with empty files array', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 1,
      content: 'Message without files',
      files: []
    });

    const messages = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const sentMessage = messages.messages[0];

    expect(sentMessage!.content).toBe('Message without files');
    expect(sentMessage!.files).toBeDefined();
    expect(sentMessage!.files.length).toBe(0);
  });

  // ---- Bulk Delete Tests ----

  test('should bulk delete multiple messages', async () => {
    const { caller } = await initTest();

    // Get baseline count (seed data includes a message in channel 1)
    const baseline = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });
    const baselineCount = baseline.messages.length;

    for (let i = 0; i < 5; i++) {
      await caller.messages.send({
        channelId: 1,
        content: `Bulk msg ${i}`,
        files: []
      });
    }

    const before = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    expect(before.messages.length).toBe(baselineCount + 5);

    const idsToDelete = before.messages.slice(0, 3).map((m) => m.id);

    const result = await caller.messages.bulkDelete({
      messageIds: idsToDelete
    });

    expect(result.deletedCount).toBe(3);

    const after = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    expect(after.messages.length).toBe(baselineCount + 2);

    for (const id of idsToDelete) {
      expect(after.messages.find((m) => m.id === id)).toBeUndefined();
    }
  });

  test('should reject bulk delete without MANAGE_MESSAGES permission', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);

    await caller1.messages.send({
      channelId: 1,
      content: 'msg',
      files: []
    });

    const msgs = await caller1.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = msgs.messages[0]!.id;

    await expect(
      caller2.messages.bulkDelete({ messageIds: [messageId] })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should reject bulk delete with more than 100 messages', async () => {
    const { caller } = await initTest();

    const fakeIds = Array.from({ length: 101 }, (_, i) => i + 1);

    await expect(
      caller.messages.bulkDelete({ messageIds: fakeIds })
    ).rejects.toThrow();
  });

  // ---- Purge Channel Tests ----

  test('should purge all messages in a channel', async () => {
    const { caller } = await initTest();

    for (let i = 0; i < 5; i++) {
      await caller.messages.send({
        channelId: 1,
        content: `msg ${i}`,
        files: []
      });
    }

    const before = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    expect(before.messages.length).toBeGreaterThanOrEqual(5);

    await caller.messages.purge({
      channelId: 1,
      confirmChannelName: 'General'
    });

    const after = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    expect(after.messages.length).toBe(0);
  });

  test('should reject purge with wrong channel name', async () => {
    const { caller } = await initTest();

    await expect(
      caller.messages.purge({
        channelId: 1,
        confirmChannelName: 'wrong-name'
      })
    ).rejects.toThrow('Channel name does not match');
  });

  test('should reject purge without MANAGE_MESSAGES permission', async () => {
    const { caller: caller2 } = await initTest(2);

    await expect(
      caller2.messages.purge({
        channelId: 1,
        confirmChannelName: 'General'
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should update message updatedAt timestamp on edit', async () => {
    const { caller } = await initTest();

    await caller.messages.send({
      channelId: 1,
      content: 'Original message',
      files: []
    });

    const messagesBefore = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const messageId = messagesBefore.messages[0]!.id;
    const originalUpdatedAt = messagesBefore.messages[0]!.updatedAt;

    await Bun.sleep(10);

    await caller.messages.edit({
      messageId,
      content: 'Edited message'
    });

    const messagesAfter = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const editedMessage = messagesAfter.messages.find(
      (m) => m.id === messageId
    );

    expect(editedMessage!.updatedAt).toBeDefined();
    expect(editedMessage!.updatedAt).not.toBe(originalUpdatedAt);
    expect(editedMessage!.updatedAt).toBeGreaterThan(
      originalUpdatedAt ?? editedMessage!.createdAt
    );
  });
});
