import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { initTest } from '../../__tests__/helpers';

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

  test('should reject forum post with content exceeding 4000 chars', async () => {
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
        content: 'a'.repeat(4001)
      })
    ).rejects.toThrow();
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
});
