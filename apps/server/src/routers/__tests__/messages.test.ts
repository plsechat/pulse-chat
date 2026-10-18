import {
  ChannelPermission,
  ChannelType,
  MAX_MESSAGE_CONTENT_LENGTH,
  ServerEvents
} from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import {
  createEmptyTextChannel,
  createTestChannel,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { countQueries } from '../../__tests__/query-count';
import { publishMessage } from '../../db/publishers';
import {
  channelReadStates,
  channelUserPermissions,
  channels,
  messages,
  serverMembers,
  userRoles,
  users
} from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import {
  isTypingSignalRateLimited,
  TYPING_SIGNAL_MIN_INTERVAL_MS
} from '../messages/signal-typing';

/** A private TEXT channel in the bootstrap server with no override rows. */
const insertPrivateChannel = async (name: string) => {
  const [channel] = await getTestDb()
    .insert(channels)
    .values({
      type: ChannelType.TEXT,
      name,
      position: 70,
      private: true,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      publicId: randomUUIDv7(),
      categoryId: 1,
      serverId: 1,
      createdAt: Date.now()
    })
    .returning();
  return channel!;
};

/** Grant one channel permission to a user on a private channel. */
const grantChannelPermission = (
  channelId: number,
  userId: number,
  permission: ChannelPermission
) =>
  getTestDb()
    .insert(channelUserPermissions)
    .values({
      channelId,
      userId,
      permission,
      allow: true,
      createdAt: Date.now()
    });

// Exact-count tests need a TEXT channel with no seeded messages: channel 1
// carries a seed message, and channel 2 is the seeded VOICE channel, which
// no longer accepts messages. Called inside each test (not beforeEach) so
// it doesn't compete with the global per-test TRUNCATE.
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

  test('should throw when user lacks permissions (toggleReaction)', async () => {
    const tdb = getTestDb();
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2, ctx: ctx2 } = await initTest(2);

    // Remove user 2's roles so they lack REACT_TO_MESSAGES
    await tdb.delete(userRoles).where(eq(userRoles.userId, 2));
    ctx2.invalidatePermissionCache();

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
    const channel = await createEmptyTextChannel('get-messages');

    await caller.messages.send({
      channelId: channel.id,
      content: 'Message 1',
      files: []
    });

    await caller.messages.send({
      channelId: channel.id,
      content: 'Message 2',
      files: []
    });

    await caller.messages.send({
      channelId: channel.id,
      content: 'Message 3',
      files: []
    });

    const result = await caller.messages.get({
      channelId: channel.id,
      cursor: null,
      limit: 50
    });

    expect(result.messages).toBeDefined();
    expect(Array.isArray(result.messages)).toBe(true);
    expect(result.messages.length).toBe(3);
  });

  test('reactions carry each reactor identity for the hover list', async () => {
    const { caller: caller1 } = await initTest(1);
    const { caller: caller2 } = await initTest(2);
    const channel = await createEmptyTextChannel('reaction-identity');

    await caller1.messages.send({
      channelId: channel.id,
      content: 'react to me',
      files: []
    });

    const before = await caller1.messages.get({
      channelId: channel.id,
      cursor: null,
      limit: 50
    });
    const messageId = before.messages[0]!.id;

    await caller1.messages.toggleReaction({ messageId, emoji: '👍' });
    await caller2.messages.toggleReaction({ messageId, emoji: '👍' });

    const after = await caller1.messages.get({
      channelId: channel.id,
      cursor: null,
      limit: 50
    });
    const reactions = after.messages.find((m) => m.id === messageId)!.reactions;

    // The client's hover resolves "who reacted" from these payloads alone —
    // each reaction must carry the reactor's name (never the raw id).
    expect(reactions).toHaveLength(2);
    const byUser = new Map(reactions.map((r) => [r.userId, r]));
    expect(byUser.get(1)!.user?.name).toBe('Test Owner');
    expect(byUser.get(2)!.user?.name).toBe('Test User');
    // Seeded users have no avatar → null (client falls back to initials).
    expect(byUser.get(1)!.user?.avatar).toBeNull();
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

    // A deletion leaves a tombstone: the row stays in the list, in
    // place, with its content gone and the deletion recorded.
    const messagesAfter = await caller.messages.get({
      channelId: 1,
      cursor: null,
      limit: 50
    });

    const tombstone = messagesAfter.messages.find((m) => m.id === messageId);
    expect(tombstone).toMatchObject({ content: null, deletedBy: 1 });
    expect(tombstone!.deletedAt).toBeGreaterThan(0);
    expect(messagesAfter.messages.length).toBe(messageCountBefore);
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

    // The admin's deletion is recorded on the tombstone.
    expect(
      messagesAfter.messages.find((m) => m.id === messageId)
    ).toMatchObject({ content: null, userId: 2, deletedBy: 1 });
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
    // Stored by shortcode, whatever spelling the client sent.
    expect(messageWithReaction!.reactions[0]!.emoji).toBe('+1');
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

    expect(emojis).toContain('+1');
    expect(emojis).toContain('heart');
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

    expect(emojis).toContain('+1');
    expect(emojis).toContain('heart');
    expect(emojis).toContain('joy');
  });

  test('every spelling of a reaction lands on one stored row: glyph, :token:, name; custom names stay bare', async () => {
    const { caller } = await initTest();

    await caller.messages.send({ channelId: 1, content: 'Spellings', files: [] });
    const messageId = (await caller.messages.get({ channelId: 1, cursor: null, limit: 1 })).messages[0]!.id;
    const reactionsOf = async () =>
      (await caller.messages.get({ channelId: 1, cursor: null, limit: 1 })).messages[0]!.reactions.map((r) => r.emoji);

    // The glyph adds `+1`; the token form toggles the SAME row off; the name adds it back.
    await caller.messages.toggleReaction({ messageId, emoji: '👍' });
    expect(await reactionsOf()).toEqual(['+1']);
    await caller.messages.toggleReaction({ messageId, emoji: ':+1:' });
    expect(await reactionsOf()).toEqual([]);
    await caller.messages.toggleReaction({ messageId, emoji: '+1' });
    expect(await reactionsOf()).toEqual(['+1']);
    // The variation selector does not make a different heart.
    await caller.messages.toggleReaction({ messageId, emoji: '❤️' });
    await caller.messages.toggleReaction({ messageId, emoji: '❤' });
    expect(await reactionsOf()).toEqual(['+1']);
    // A custom emoji token is stored by its bare name (the emoji table is keyed on it).
    await caller.messages.toggleReaction({ messageId, emoji: ':pogchamp:' });
    expect(await reactionsOf()).toEqual(['+1', 'pogchamp']);
    // What is left after normalizing must still be something.
    await expect(caller.messages.toggleReaction({ messageId, emoji: '   ' })).rejects.toThrow();
  });

  test('should send multiple messages', async () => {
    const { caller } = await initTest();
    const channel = await createEmptyTextChannel('multi-send');

    const messageCount = 5;
    const promises = [];

    for (let i = 0; i < messageCount; i++) {
      promises.push(
        caller.messages.send({
          channelId: channel.id,
          content: `Message ${i + 1}`,
          files: []
        })
      );
    }

    await Promise.all(promises);

    const messages = await caller.messages.get({
      channelId: channel.id,
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
    const channel = await createEmptyTextChannel('empty-channel');

    const messages = await caller.messages.get({
      channelId: channel.id,
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

    // Tombstones: the rows stay, marked, and the others are untouched.
    expect(after.messages.length).toBe(baselineCount + 5);

    for (const id of idsToDelete) {
      expect(after.messages.find((m) => m.id === id)).toMatchObject({
        content: null,
        deletedBy: 1
      });
    }
    expect(after.messages.filter((m) => m.deletedAt == null)).toHaveLength(baselineCount + 2);
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

  describe('forward attribution', () => {
    test('server derives forwarded-from from the source; the copy is not editable', async () => {
      const { caller: author } = await initTest(2);
      const { caller: forwarder } = await initTest(1);
      const tdb = getTestDb();

      // User 2 authors the source message.
      await author.messages.send({
        channelId: 1,
        content: `source ${randomUUIDv7()}`
      });
      const [source] = await tdb
        .select()
        .from(messages)
        .where(eq(messages.userId, 2))
        .orderBy(messages.id);

      // User 1 forwards it — attribution is derived server-side, NOT
      // taken from the client.
      await forwarder.messages.send({
        channelId: 1,
        content: 'forwarded copy',
        forwardedFrom: { sourceKind: 'channel', sourceId: source!.id }
      });
      const [fwd] = await tdb
        .select()
        .from(messages)
        .where(eq(messages.content, 'forwarded copy'));
      expect(fwd!.forwardedFromUserId).toBe(2);
      expect(typeof fwd!.forwardedFromName).toBe('string');
      expect(fwd!.userId).toBe(1); // the forwarder authored the copy

      // A forward is a verbatim 1:1 copy — even its own author cannot
      // edit it, so attribution can never sit over altered content.
      expect(fwd!.editable).toBe(false);
      await expect(
        forwarder.messages.edit({
          messageId: fwd!.id,
          content: 'tampered'
        })
      ).rejects.toThrow('not editable');
    });

    test('an out-of-scope source reads as not found', async () => {
      const { caller: forwarder } = await initTest(1);
      await expect(
        forwarder.messages.send({
          channelId: 1,
          content: 'x',
          forwardedFrom: { sourceKind: 'channel', sourceId: 999999 }
        })
      ).rejects.toThrow('Source message not found');
    });
  });

  describe('reply validation', () => {
    test('a reply must target a message in the same channel', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const secret = await insertPrivateChannel('reply-secret');

      const secretId = await owner.messages.send({
        channelId: secret.id,
        content: 'private text'
      });

      // From #general, a member references the private message by id.
      await expect(
        member.messages.send({
          channelId: 1,
          content: 'quoting you',
          replyToId: secretId
        })
      ).rejects.toThrow('Reply target not found in this channel');

      await expect(
        member.messages.send({
          channelId: 1,
          content: 'quoting nothing',
          replyToId: 999999
        })
      ).rejects.toThrow('Reply target not found in this channel');

      // Same-channel reply works and the preview resolves.
      const target = await member.messages.send({
        channelId: 1,
        content: 'target'
      });
      const replyId = await member.messages.send({
        channelId: 1,
        content: 'reply',
        replyToId: target
      });
      const page = await member.messages.get({ channelId: 1, limit: 10 });
      const reply = page.messages.find((m) => m.id === replyId);
      expect(reply!.replyTo?.content).toBe('target');
    });
  });

  describe('pagination bounds', () => {
    test('limit above 100 and non-integer cursors are rejected', async () => {
      const { caller } = await initTest(1);

      await expect(
        caller.messages.get({ channelId: 1, limit: 101 })
      ).rejects.toThrow();
      await expect(
        caller.messages.get({ channelId: 1, limit: 0 })
      ).rejects.toThrow();
      await expect(
        caller.messages.get({ channelId: 1, cursor: 1.5 })
      ).rejects.toThrow();
      await expect(
        caller.messages.get({ channelId: 1, aroundId: 0 })
      ).rejects.toThrow();

      const ok = await caller.messages.get({ channelId: 1, limit: 100 });
      expect(Array.isArray(ok.messages)).toBe(true);
    });
  });

  describe('encryption flag symmetry', () => {
    test('an encrypted send into a plaintext channel is rejected', async () => {
      const { caller } = await initTest(1);

      await expect(
        caller.messages.send({
          channelId: 1,
          content: 'ciphertext',
          e2ee: true
        })
      ).rejects.toThrow('not encrypted');
    });

    test('a plaintext send into an encrypted channel is rejected', async () => {
      const { caller } = await initTest(1);
      const e2eeChannel = await createTestChannel({ serverId: 1, e2ee: true });

      await expect(
        caller.messages.send({
          channelId: e2eeChannel,
          content: 'plaintext'
        })
      ).rejects.toThrow('This channel requires E2EE messages');

      await caller.messages.send({
        channelId: e2eeChannel,
        content: 'ciphertext',
        e2ee: true
      });
    });
  });

  describe('content caps', () => {
    test('plaintext is capped at MAX_MESSAGE_CONTENT_LENGTH on send and edit', async () => {
      const { caller } = await initTest(1);
      const channel = await createEmptyTextChannel('caps');

      await expect(
        caller.messages.send({
          channelId: channel.id,
          content: 'a'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
        })
      ).rejects.toThrow('Message is too long');

      const messageId = await caller.messages.send({
        channelId: channel.id,
        content: 'a'.repeat(MAX_MESSAGE_CONTENT_LENGTH)
      });

      await expect(
        caller.messages.edit({
          messageId,
          content: 'b'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
        })
      ).rejects.toThrow('Message is too long');
    });

    test('ciphertext may exceed the plaintext cap up to the wire cap', async () => {
      const { caller } = await initTest(1);
      const e2eeChannel = await createTestChannel({ serverId: 1, e2ee: true });

      await caller.messages.send({
        channelId: e2eeChannel,
        content: 'c'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1),
        e2ee: true
      });
    });

    test('attachment list and ids are bounded', async () => {
      const { caller } = await initTest(1);

      await expect(
        caller.messages.send({
          channelId: 1,
          content: 'x',
          files: Array.from({ length: 11 }, () => 'temp-id')
        })
      ).rejects.toThrow();
      await expect(
        caller.messages.send({
          channelId: 1,
          content: 'x',
          files: ['f'.repeat(65)]
        })
      ).rejects.toThrow();
    });
  });

  describe('pin / unpin / getPinned', () => {
    test('pin and unpin round-trip through getPinned', async () => {
      const { caller } = await initTest(1);
      const channel = await createEmptyTextChannel('pins');

      const messageId = await caller.messages.send({
        channelId: channel.id,
        content: 'pin me'
      });

      await caller.messages.pin({ messageId });
      await expect(caller.messages.pin({ messageId })).rejects.toThrow(
        'already pinned'
      );

      const pinned = await caller.messages.getPinned({ channelId: channel.id });
      expect(pinned.map((m) => m.id)).toEqual([messageId]);
      expect(pinned[0]!.pinnedBy).toBe(1);

      await caller.messages.unpin({ messageId });
      await expect(caller.messages.unpin({ messageId })).rejects.toThrow(
        'not pinned'
      );
      expect(
        await caller.messages.getPinned({ channelId: channel.id })
      ).toHaveLength(0);
    });

    test('pin needs PIN_MESSAGES', async () => {
      const tdb = getTestDb();
      const { caller: owner } = await initTest(1);
      const { caller: member, ctx: memberCtx } = await initTest(2);

      const messageId = await owner.messages.send({
        channelId: 1,
        content: 'pin target'
      });

      await tdb.delete(userRoles).where(eq(userRoles.userId, 2));
      memberCtx.invalidatePermissionCache();

      await expect(member.messages.pin({ messageId })).rejects.toThrow(
        'Insufficient permissions'
      );
    });

    test('pin/unpin/getPinned need VIEW on a private channel; scope is the server', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const secret = await insertPrivateChannel('pin-secret');

      const messageId = await owner.messages.send({
        channelId: secret.id,
        content: 'hidden'
      });

      await expect(member.messages.pin({ messageId })).rejects.toThrow(
        'Insufficient channel permissions'
      );
      await expect(
        member.messages.getPinned({ channelId: secret.id })
      ).rejects.toThrow('Insufficient channel permissions');

      await owner.messages.pin({ messageId });
      await expect(member.messages.unpin({ messageId })).rejects.toThrow(
        'Insufficient channel permissions'
      );

      // A message in another server reads as not found.
      const other = await insertOtherServer();
      const foreignChannel = await createTestChannel({ serverId: other.id });
      const [foreign] = await getTestDb()
        .insert(messages)
        .values({
          content: 'foreign',
          userId: 1,
          channelId: foreignChannel,
          createdAt: Date.now()
        })
        .returning();
      await expect(
        owner.messages.pin({ messageId: foreign!.id })
      ).rejects.toThrow('Message not found');
    });
  });

  describe('reactions on private channels', () => {
    test('reacting needs VIEW on the message channel; emoji is bounded', async () => {
      const { caller: owner } = await initTest(1);
      const { caller: member } = await initTest(2);
      const secret = await insertPrivateChannel('react-secret');

      const messageId = await owner.messages.send({
        channelId: secret.id,
        content: 'hidden'
      });

      await expect(
        member.messages.toggleReaction({ messageId, emoji: '👍' })
      ).rejects.toThrow('Insufficient channel permissions');

      await grantChannelPermission(
        secret.id,
        2,
        ChannelPermission.VIEW_CHANNEL
      );
      const { caller: viewer } = await initTest(2);
      await viewer.messages.toggleReaction({ messageId, emoji: '👍' });

      await expect(
        viewer.messages.toggleReaction({ messageId, emoji: '' })
      ).rejects.toThrow();
      await expect(
        viewer.messages.toggleReaction({ messageId, emoji: 'x'.repeat(65) })
      ).rejects.toThrow();
    });
  });

  describe('signalTyping', () => {
    afterEach(() => {
      mock.restore();
    });

    test('needs channel SEND_MESSAGES and server scope', async () => {
      const { caller: member } = await initTest(2);
      const secret = await insertPrivateChannel('typing-secret');

      await expect(
        member.messages.signalTyping({ channelId: secret.id })
      ).rejects.toThrow('Insufficient channel permissions');

      const other = await insertOtherServer();
      const foreignChannel = await createTestChannel({ serverId: other.id });
      await expect(
        member.messages.signalTyping({ channelId: foreignChannel })
      ).rejects.toThrow('Channel not found');

      await expect(
        member.messages.signalTyping({ channelId: 0 })
      ).rejects.toThrow();
    });

    test('the limiter admits one signal per window per (user, channel)', () => {
      // Injected clock: the floor is measured in the limiter's own time
      // base, independent of how long the route's queries take.
      const userId = 987654;
      const channelId = 123456;
      const t0 = 1_000_000;

      expect(isTypingSignalRateLimited(userId, channelId, t0)).toBe(false);
      expect(isTypingSignalRateLimited(userId, channelId, t0 + 1)).toBe(true);
      expect(
        isTypingSignalRateLimited(
          userId,
          channelId,
          t0 + TYPING_SIGNAL_MIN_INTERVAL_MS - 1
        )
      ).toBe(true);
      // Keys are per channel and per user: neither neighbour is throttled.
      expect(isTypingSignalRateLimited(userId, channelId + 1, t0 + 1)).toBe(
        false
      );
      expect(isTypingSignalRateLimited(userId + 1, channelId, t0 + 1)).toBe(
        false
      );
      // The window lapses exactly at the floor.
      expect(
        isTypingSignalRateLimited(
          userId,
          channelId,
          t0 + TYPING_SIGNAL_MIN_INTERVAL_MS
        )
      ).toBe(false);
    });

    test('an admitted signal fans out to the channel viewers', async () => {
      const { caller } = await initTest(1);
      const channel = await createEmptyTextChannel('typing-fanout');

      // Ids restart between tests, so a previous test may have stamped
      // this (user, channel) key moments ago — let the window lapse.
      await Bun.sleep(TYPING_SIGNAL_MIN_INTERVAL_MS);

      const publishFor = spyOn(pubsub, 'publishFor');
      await caller.messages.signalTyping({ channelId: channel.id });

      const typing = publishFor.mock.calls.filter(
        (c) => c[1] === ServerEvents.MESSAGE_TYPING
      );
      expect(typing).toHaveLength(1);
      expect(typing[0]![2]).toEqual({ channelId: channel.id, userId: 1 });
    });
  });

  describe('publishMessage unread fan-out', () => {
    /** CHANNEL_READ_STATES_UPDATE payloads keyed by recipient. */
    const readStateUpdates = (
      calls: unknown[][],
      channelId: number
    ): Map<number, { count: number; mentionCount: number }> => {
      const out = new Map<number, { count: number; mentionCount: number }>();
      for (const call of calls) {
        if (call[1] !== ServerEvents.CHANNEL_READ_STATES_UPDATE) continue;
        const payload = call[2] as {
          channelId: number;
          count: number;
          mentionCount: number;
        };
        if (payload.channelId !== channelId) continue;
        out.set(call[0] as number, {
          count: payload.count,
          mentionCount: payload.mentionCount
        });
      }
      return out;
    };

    test('query count is independent of the recipient count; counts are exact', async () => {
      const tdb = getTestDb();
      const now = Date.now();
      const [seeded] = await tdb
        .select({ id: messages.id })
        .from(messages)
        .where(eq(messages.channelId, 1))
        .limit(1);

      // Users 2 and 3 have read up to the seeded message.
      await tdb.insert(channelReadStates).values([
        { userId: 2, channelId: 1, lastReadMessageId: seeded!.id, lastReadAt: now },
        { userId: 3, channelId: 1, lastReadMessageId: seeded!.id, lastReadAt: now }
      ]);
      const [first] = await tdb
        .insert(messages)
        .values({
          content: 'hi <@2>',
          userId: 1,
          channelId: 1,
          mentionedUserIds: [2],
          createdAt: now
        })
        .returning({ id: messages.id });

      const publishFor = spyOn(pubsub, 'publishFor');
      try {
        const baseline = await countQueries(() =>
          publishMessage(first!.id, 1, 'create')
        );
        const small = readStateUpdates(publishFor.mock.calls, 1);
        expect(small.get(2)).toEqual({ count: 1, mentionCount: 1 });
        expect(small.get(3)).toEqual({ count: 1, mentionCount: 0 });
        expect(small.has(1)).toBe(false); // never the author

        // 50 more members, all read up to `first`.
        const extraIds: number[] = [];
        for (let i = 0; i < 50; i++) {
          const [u] = await tdb
            .insert(users)
            .values({
              name: `fanout-${i}-${randomUUIDv7().slice(0, 6)}`,
              supabaseId: `fanout-${randomUUIDv7()}`,
              publicId: randomUUIDv7(),
              createdAt: now
            })
            .returning({ id: users.id });
          extraIds.push(u!.id);
        }
        await tdb.insert(serverMembers).values(
          extraIds.map((userId) => ({ serverId: 1, userId, joinedAt: now }))
        );
        await tdb.insert(channelReadStates).values(
          extraIds.map((userId) => ({
            userId,
            channelId: 1,
            lastReadMessageId: first!.id,
            lastReadAt: now
          }))
        );
        const mentioned = extraIds.slice(0, 5);
        const [second] = await tdb
          .insert(messages)
          .values({
            content: 'again',
            userId: 1,
            channelId: 1,
            mentionedUserIds: mentioned,
            createdAt: now + 1
          })
          .returning({ id: messages.id });

        publishFor.mockClear();
        const big = await countQueries(() =>
          publishMessage(second!.id, 1, 'create')
        );

        expect(big.queries).toBe(baseline.queries);
        expect(big.queries).toBeLessThanOrEqual(12);

        const large = readStateUpdates(publishFor.mock.calls, 1);
        expect(large.size).toBe(52);
        expect(large.get(2)).toEqual({ count: 2, mentionCount: 1 });
        expect(large.get(3)).toEqual({ count: 2, mentionCount: 0 });
        for (const id of extraIds) {
          expect(large.get(id)).toEqual({
            count: 1,
            mentionCount: mentioned.includes(id) ? 1 : 0
          });
        }
      } finally {
        publishFor.mockRestore();
      }
    });
  });
});
