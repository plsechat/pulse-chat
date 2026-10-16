import {
  ChannelPermission,
  ChannelType,
  MAX_MESSAGE_CONTENT_LENGTH
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  createEmptyTextChannel,
  createTestChannel
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  channelUserPermissions,
  channels,
  forumPostTags,
  threadFollowers
} from '../../db/schema';

/** A private channel of `type` in the bootstrap server, no override rows. */
const insertPrivateChannel = async (name: string, type: ChannelType) => {
  const [channel] = await getTestDb()
    .insert(channels)
    .values({
      type,
      name,
      position: 80,
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

const grantChannelPermissions = async (
  channelId: number,
  userId: number,
  permissions: ChannelPermission[]
) => {
  await getTestDb().insert(channelUserPermissions).values(
    permissions.map((permission) => ({
      channelId,
      userId,
      permission,
      allow: true,
      createdAt: Date.now()
    }))
  );
};

const loadChannel = async (id: number) => {
  const [row] = await getTestDb()
    .select()
    .from(channels)
    .where(eq(channels.id, id));
  return row!;
};

describe('forums', () => {
  // ── Channel creation ──────────────────────────────────────────────

  test('should create a forum channel', async () => {
    const { caller } = await initTest();

    const channelId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'test-forum',
      categoryId: 1,
      serverId: 1
    });

    const channel = await caller.channels.get({ channelId });

    expect(channel).toBeDefined();
    expect(channel.name).toBe('test-forum');
    expect(channel.type).toBe(ChannelType.FORUM);
  });

  test('should throw when non-admin creates a forum channel', async () => {
    const { caller } = await initTest(2);

    await expect(
      caller.channels.add({
        type: ChannelType.FORUM,
        name: 'no-perms',
        categoryId: 1,
        serverId: 1
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  // ── Forum posts ───────────────────────────────────────────────────

  test('should create a forum post', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'post-forum',
      categoryId: 1,
      serverId: 1
    });

    const result = await caller.threads.createForumPost({
      channelId: forumId,
      title: 'My First Post',
      content: 'Hello forum world!'
    });

    expect(result).toBeDefined();
    expect(result.threadId).toBeDefined();
    expect(typeof result.threadId).toBe('number');
  });

  test('should reject forum post on a non-forum channel', async () => {
    const { caller } = await initTest();

    // channel 1 is a TEXT channel from test seed
    await expect(
      caller.threads.createForumPost({
        channelId: 1,
        title: 'Bad Post',
        content: 'This should fail'
      })
    ).rejects.toThrow();
  });

  test('should reject forum post with empty title', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'validate-forum',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      caller.threads.createForumPost({
        channelId: forumId,
        title: '',
        content: 'Has content'
      })
    ).rejects.toThrow();
  });

  test('should reject forum post with empty content', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'validate-forum2',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      caller.threads.createForumPost({
        channelId: forumId,
        title: 'Has title',
        content: ''
      })
    ).rejects.toThrow();
  });

  test('should reject forum post with title exceeding 200 chars', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'long-title',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      caller.threads.createForumPost({
        channelId: forumId,
        title: 'a'.repeat(201),
        content: 'Some content'
      })
    ).rejects.toThrow();
  });

  test('should cap forum post content at the plaintext message budget', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'long-content',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      caller.threads.createForumPost({
        channelId: forumId,
        title: 'Valid title',
        content: 'a'.repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
      })
    ).rejects.toThrow();

    // A post is an ordinary message in its thread — same cap, not 4000.
    const { threadId } = await caller.threads.createForumPost({
      channelId: forumId,
      title: 'Long but legal',
      content: 'a'.repeat(MAX_MESSAGE_CONTENT_LENGTH)
    });
    expect(typeof threadId).toBe('number');
  });

  // ── Listing threads ───────────────────────────────────────────────

  test('should list forum posts', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'list-forum',
      categoryId: 1,
      serverId: 1
    });

    await caller.threads.createForumPost({
      channelId: forumId,
      title: 'Post A',
      content: 'Content A'
    });

    await caller.threads.createForumPost({
      channelId: forumId,
      title: 'Post B',
      content: 'Content B'
    });

    const threads = await caller.threads.getAll({
      channelId: forumId
    });

    expect(threads.length).toBe(2);
    expect(threads.some((t) => t.name === 'Post A')).toBe(true);
    expect(threads.some((t) => t.name === 'Post B')).toBe(true);
  });

  test('should return message count and lastMessageAt', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'stats-forum',
      categoryId: 1,
      serverId: 1
    });

    const { threadId } = await caller.threads.createForumPost({
      channelId: forumId,
      title: 'Stats Post',
      content: 'Initial content'
    });

    // The initial message counts as 1
    const threads = await caller.threads.getAll({ channelId: forumId });
    const post = threads.find((t) => t.id === threadId);

    expect(post).toBeDefined();
    expect(post!.messageCount).toBe(1);
    expect(post!.lastMessageAt).not.toBeNull();
  });

  test('should return empty list for forum with no posts', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'empty-forum',
      categoryId: 1,
      serverId: 1
    });

    const threads = await caller.threads.getAll({ channelId: forumId });

    expect(threads).toEqual([]);
  });

  // ── Archiving ─────────────────────────────────────────────────────

  test('should archive a forum post', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'archive-forum',
      categoryId: 1,
      serverId: 1
    });

    const { threadId } = await caller.threads.createForumPost({
      channelId: forumId,
      title: 'Archive Me',
      content: 'Will be archived'
    });

    await caller.threads.archive({
      threadId,
      archived: true
    });

    // Archived posts hidden by default
    const threads = await caller.threads.getAll({ channelId: forumId });

    expect(threads.length).toBe(0);

    // Visible when includeArchived is true
    const allThreads = await caller.threads.getAll({
      channelId: forumId,
      includeArchived: true
    });

    expect(allThreads.length).toBe(1);
    expect(allThreads[0]!.archived).toBe(true);
  });

  test('should unarchive a forum post', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'unarchive-forum',
      categoryId: 1,
      serverId: 1
    });

    const { threadId } = await caller.threads.createForumPost({
      channelId: forumId,
      title: 'Unarchive Me',
      content: 'Will be unarchived'
    });

    await caller.threads.archive({ threadId, archived: true });
    await caller.threads.archive({ threadId, archived: false });

    const threads = await caller.threads.getAll({ channelId: forumId });

    expect(threads.length).toBe(1);
    expect(threads[0]!.archived).toBe(false);
  });

  test('should throw when non-admin archives a post', async () => {
    const { caller: admin } = await initTest(1);
    const { caller: user } = await initTest(2);

    const forumId = await admin.channels.add({
      type: ChannelType.FORUM,
      name: 'perm-archive',
      categoryId: 1,
      serverId: 1
    });

    const { threadId } = await admin.threads.createForumPost({
      channelId: forumId,
      title: 'Admin Post',
      content: 'Only admin can archive'
    });

    await expect(
      user.threads.archive({ threadId, archived: true })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when archiving non-existent thread', async () => {
    const { caller } = await initTest();

    await expect(
      caller.threads.archive({ threadId: 99999, archived: true })
    ).rejects.toThrow();
  });

  // ── Forum tags ────────────────────────────────────────────────────

  test('should create a forum tag', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'tag-forum',
      categoryId: 1,
      serverId: 1
    });

    const tag = await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Bug',
      color: '#ff0000'
    });

    expect(tag).toBeDefined();
    expect(tag!.name).toBe('Bug');
    expect(tag!.color).toBe('#ff0000');
    expect(tag!.channelId).toBe(forumId);
  });

  test('should create a tag with default color', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'default-color',
      categoryId: 1,
      serverId: 1
    });

    const tag = await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Discussion'
    });

    expect(tag!.color).toBe('#808080');
  });

  test('should list forum tags', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'list-tags',
      categoryId: 1,
      serverId: 1
    });

    await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Bug',
      color: '#ff0000'
    });

    await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Feature',
      color: '#00ff00'
    });

    const tags = await caller.threads.getForumTags({ channelId: forumId });

    expect(tags.length).toBe(2);
    expect(tags.some((t) => t.name === 'Bug')).toBe(true);
    expect(tags.some((t) => t.name === 'Feature')).toBe(true);
  });

  test('should return empty tags for forum with no tags', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'no-tags',
      categoryId: 1,
      serverId: 1
    });

    const tags = await caller.threads.getForumTags({ channelId: forumId });

    expect(tags).toEqual([]);
  });

  test('should update a forum tag', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'update-tag',
      categoryId: 1,
      serverId: 1
    });

    const tag = await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Old Name',
      color: '#111111'
    });

    const updated = await caller.threads.updateForumTag({
      tagId: tag!.id,
      name: 'New Name',
      color: '#222222'
    });

    expect(updated!.name).toBe('New Name');
    expect(updated!.color).toBe('#222222');
  });

  test('should delete a forum tag', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'delete-tag',
      categoryId: 1,
      serverId: 1
    });

    const tag = await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Temporary'
    });

    await caller.threads.deleteForumTag({ tagId: tag!.id });

    const tags = await caller.threads.getForumTags({ channelId: forumId });

    expect(tags.length).toBe(0);
  });

  test('should throw when non-admin creates a tag', async () => {
    const { caller: admin } = await initTest(1);
    const { caller: user } = await initTest(2);

    const forumId = await admin.channels.add({
      type: ChannelType.FORUM,
      name: 'tag-perms',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      user.threads.createForumTag({
        channelId: forumId,
        name: 'Blocked'
      })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when non-admin updates a tag', async () => {
    const { caller: admin } = await initTest(1);
    const { caller: user } = await initTest(2);

    const forumId = await admin.channels.add({
      type: ChannelType.FORUM,
      name: 'tag-update-perms',
      categoryId: 1,
      serverId: 1
    });

    const tag = await admin.threads.createForumTag({
      channelId: forumId,
      name: 'Protected'
    });

    await expect(
      user.threads.updateForumTag({ tagId: tag!.id, name: 'Hacked' })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when non-admin deletes a tag', async () => {
    const { caller: admin } = await initTest(1);
    const { caller: user } = await initTest(2);

    const forumId = await admin.channels.add({
      type: ChannelType.FORUM,
      name: 'tag-delete-perms',
      categoryId: 1,
      serverId: 1
    });

    const tag = await admin.threads.createForumTag({
      channelId: forumId,
      name: 'Undeletable'
    });

    await expect(
      user.threads.deleteForumTag({ tagId: tag!.id })
    ).rejects.toThrow('Insufficient permissions');
  });

  test('should throw when updating non-existent tag', async () => {
    const { caller } = await initTest();

    await expect(
      caller.threads.updateForumTag({ tagId: 99999, name: 'Nope' })
    ).rejects.toThrow();
  });

  test('should throw when deleting non-existent tag', async () => {
    const { caller } = await initTest();

    await expect(
      caller.threads.deleteForumTag({ tagId: 99999 })
    ).rejects.toThrow();
  });

  test('should reject tag on non-forum channel', async () => {
    const { caller } = await initTest();

    // channel 1 is a TEXT channel
    await expect(
      caller.threads.createForumTag({
        channelId: 1,
        name: 'Bad Tag'
      })
    ).rejects.toThrow();
  });

  // ── Forum posts with tags ────────────────────────────────────────

  test('should create a forum post with tags', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'tagged-posts',
      categoryId: 1,
      serverId: 1
    });

    const tag1 = await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Bug',
      color: '#ff0000'
    });

    const tag2 = await caller.threads.createForumTag({
      channelId: forumId,
      name: 'Priority',
      color: '#ff8800'
    });

    const result = await caller.threads.createForumPost({
      channelId: forumId,
      title: 'Tagged Post',
      content: 'This post has tags',
      tagIds: [tag1!.id, tag2!.id]
    });

    expect(result.threadId).toBeDefined();
  });

  // ── Forum post on non-existent channel ────────────────────────────

  test('should throw when creating post on non-existent channel', async () => {
    const { caller } = await initTest();

    await expect(
      caller.threads.createForumPost({
        channelId: 99999,
        title: 'Ghost Post',
        content: 'No channel here'
      })
    ).rejects.toThrow();
  });

  // ── Tag name validation ───────────────────────────────────────────

  test('should reject tag with empty name', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'empty-tag-name',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      caller.threads.createForumTag({
        channelId: forumId,
        name: ''
      })
    ).rejects.toThrow();
  });

  test('should reject tag with name exceeding 50 chars', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'long-tag-name',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      caller.threads.createForumTag({
        channelId: forumId,
        name: 'a'.repeat(51)
      })
    ).rejects.toThrow();
  });

  test('should reject a tag colour that is not hex', async () => {
    const { caller } = await initTest();

    const forumId = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'css-colour',
      categoryId: 1,
      serverId: 1
    });

    await expect(
      caller.threads.createForumTag({
        channelId: forumId,
        name: 'bad',
        color: 'url(javascript:1)'
      })
    ).rejects.toThrow('Invalid hex color');

    const tag = await caller.threads.createForumTag({
      channelId: forumId,
      name: 'good',
      color: '#abc'
    });
    await expect(
      caller.threads.updateForumTag({ tagId: tag!.id, color: 'red' })
    ).rejects.toThrow('Invalid hex color');
  });

  // ── Channel-level authorization ───────────────────────────────────

  test('posting into a private forum needs channel SEND_MESSAGES', async () => {
    const { caller: member } = await initTest(2);
    const forum = await insertPrivateChannel('private-forum', ChannelType.FORUM);

    await expect(
      member.threads.createForumPost({
        channelId: forum.id,
        title: 'sneak',
        content: 'in'
      })
    ).rejects.toThrow('Insufficient channel permissions');

    await grantChannelPermissions(forum.id, 2, [
      ChannelPermission.VIEW_CHANNEL,
      ChannelPermission.SEND_MESSAGES
    ]);
    const { caller: allowed } = await initTest(2);
    const { threadId } = await allowed.threads.createForumPost({
      channelId: forum.id,
      title: 'allowed',
      content: 'in'
    });

    // The post inherits the forum's visibility and its viewer set.
    const thread = await loadChannel(threadId);
    expect(thread.private).toBe(true);

    const { caller: outsider } = await initTest(3);
    await expect(
      outsider.messages.get({ channelId: threadId, limit: 10 })
    ).rejects.toThrow('Insufficient channel permissions');
    const page = await allowed.messages.get({ channelId: threadId, limit: 10 });
    expect(page.messages).toHaveLength(1);
  });

  test('tags must belong to the forum; count is bounded', async () => {
    const { caller } = await initTest();

    const forumA = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'forum-a',
      categoryId: 1,
      serverId: 1
    });
    const forumB = await caller.channels.add({
      type: ChannelType.FORUM,
      name: 'forum-b',
      categoryId: 1,
      serverId: 1
    });
    const tagB = await caller.threads.createForumTag({
      channelId: forumB,
      name: 'b-only'
    });

    await expect(
      caller.threads.createForumPost({
        channelId: forumA,
        title: 'wrong tag',
        content: 'x',
        tagIds: [tagB!.id]
      })
    ).rejects.toThrow('do not belong to this forum');

    await expect(
      caller.threads.createForumPost({
        channelId: forumA,
        title: 'too many',
        content: 'x',
        tagIds: Array.from({ length: 21 }, (_, i) => i + 1)
      })
    ).rejects.toThrow();

    const tagA = await caller.threads.createForumTag({
      channelId: forumA,
      name: 'a'
    });
    const { threadId } = await caller.threads.createForumPost({
      channelId: forumA,
      title: 'ok',
      content: 'x',
      tagIds: [tagA!.id, tagA!.id]
    });

    await expect(
      caller.threads.updatePostTags({ threadId, tagIds: [tagB!.id] })
    ).rejects.toThrow('do not belong to this forum');

    await caller.threads.updatePostTags({ threadId, tagIds: [tagA!.id] });
    const rows = await getTestDb()
      .select()
      .from(forumPostTags)
      .where(eq(forumPostTags.threadId, threadId));
    expect(rows.map((r) => r.tagId)).toEqual([tagA!.id]);
  });

  // ── Inline threads via the router ─────────────────────────────────

  test('threads.create needs channel SEND_MESSAGES on the parent and server scope', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const secret = await insertPrivateChannel('thread-secret', ChannelType.TEXT);

    const messageId = await owner.messages.send({
      channelId: secret.id,
      content: 'seed'
    });

    await expect(
      member.threads.create({ messageId, name: 'peek' })
    ).rejects.toThrow('Insufficient channel permissions');

    await expect(
      member.threads.create({ messageId: 999999, name: 'none' })
    ).rejects.toThrow('Message not found');
  });

  test('a thread inherits e2ee from its parent and refuses plaintext', async () => {
    const { caller } = await initTest(1);
    const e2eeChannel = await createTestChannel({
      serverId: 1,
      name: 'encrypted',
      e2ee: true
    });

    const messageId = await caller.messages.send({
      channelId: e2eeChannel,
      content: 'ciphertext',
      e2ee: true
    });

    const { threadId } = await caller.threads.create({
      messageId,
      name: 'encrypted thread'
    });
    const thread = await loadChannel(threadId);
    expect(thread.e2ee).toBe(true);
    expect(thread.parentChannelId).toBe(e2eeChannel);

    await expect(
      caller.messages.send({ channelId: threadId, content: 'plaintext' })
    ).rejects.toThrow('This channel requires E2EE messages');
    await caller.messages.send({
      channelId: threadId,
      content: 'more ciphertext',
      e2ee: true
    });
  });

  test('a thread under a private parent is private to the same viewers', async () => {
    const { caller: owner } = await initTest(1);
    const secret = await insertPrivateChannel('private-parent', ChannelType.TEXT);
    await grantChannelPermissions(secret.id, 2, [
      ChannelPermission.VIEW_CHANNEL,
      ChannelPermission.SEND_MESSAGES
    ]);
    const { caller: viewer } = await initTest(2);
    const { caller: outsider } = await initTest(3);

    const messageId = await owner.messages.send({
      channelId: secret.id,
      content: 'seed'
    });
    const { threadId } = await viewer.threads.create({
      messageId,
      name: 'private thread'
    });

    const thread = await loadChannel(threadId);
    expect(thread.private).toBe(true);

    // Viewer of the parent can read and post; an outsider cannot see it.
    await viewer.messages.send({ channelId: threadId, content: 'inside' });
    const page = await viewer.messages.get({ channelId: threadId, limit: 10 });
    expect(page.messages).toHaveLength(1);
    await expect(
      outsider.messages.get({ channelId: threadId, limit: 10 })
    ).rejects.toThrow('Insufficient channel permissions');
    await expect(
      outsider.threads.followThread({ threadId, follow: true })
    ).rejects.toThrow('Insufficient channel permissions');
  });

  test('threads cannot be nested', async () => {
    const { caller } = await initTest(1);
    const channel = await createEmptyTextChannel('no-nesting');

    const messageId = await caller.messages.send({
      channelId: channel.id,
      content: 'root'
    });
    const { threadId } = await caller.threads.create({ messageId, name: 't' });
    const inner = await caller.messages.send({
      channelId: threadId,
      content: 'inside'
    });

    await expect(
      caller.threads.create({ messageId: inner, name: 'nested' })
    ).rejects.toThrow('text or forum channels');
  });

  test('follow / getFollowStatus / deleteThread via the router', async () => {
    const { caller: owner } = await initTest(1);
    const { caller: member } = await initTest(2);
    const channel = await createEmptyTextChannel('follow-me');

    const messageId = await member.messages.send({
      channelId: channel.id,
      content: 'root'
    });
    const { threadId } = await member.threads.create({ messageId, name: 't' });

    expect(await owner.threads.getFollowStatus({ threadId })).toEqual({
      following: false
    });
    await owner.threads.followThread({ threadId, follow: true });
    expect(await owner.threads.getFollowStatus({ threadId })).toEqual({
      following: true
    });
    await owner.threads.followThread({ threadId, follow: false });
    expect(await owner.threads.getFollowStatus({ threadId })).toEqual({
      following: false
    });
    await expect(
      owner.threads.followThread({ threadId: 999999, follow: true })
    ).rejects.toThrow('Thread not found');

    // Creator may delete while nobody else has posted...
    await owner.messages.send({ channelId: threadId, content: 'joined' });
    await expect(member.threads.deleteThread({ threadId })).rejects.toThrow(
      'Ask an admin'
    );
    // ...an admin always can.
    await owner.threads.deleteThread({ threadId });
    const rows = await getTestDb()
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, threadId));
    expect(rows).toHaveLength(0);
    await expect(
      owner.threads.deleteThread({ threadId })
    ).rejects.toThrow('Thread not found');
  });
});
