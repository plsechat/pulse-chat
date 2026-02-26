import { ChannelType } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  channels,
  forumPostTags,
  forumTags,
  messages,
  threadFollowers
} from '../db/schema';
import { tdb } from './setup';

/**
 * Helper: create a FORUM channel in the test DB.
 */
async function createForumChannel(serverId = 1) {
  const [forum] = await tdb
    .insert(channels)
    .values({
      type: ChannelType.FORUM,
      name: 'Test Forum',
      position: 10,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      serverId,
      createdAt: Date.now()
    })
    .returning();
  return forum!;
}

/**
 * Helper: create a THREAD channel (forum post) in the test DB.
 */
async function createForumPost(
  parentChannelId: number,
  serverId = 1,
  creatorId = 1
) {
  const now = Date.now();

  const [thread] = await tdb
    .insert(channels)
    .values({
      type: ChannelType.THREAD,
      name: 'Test Post',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: now,
      serverId,
      parentChannelId,
      createdAt: now
    })
    .returning();

  // Create initial message (the post body)
  const [msg] = await tdb
    .insert(messages)
    .values({
      content: 'Post content',
      userId: creatorId,
      channelId: thread!.id,
      createdAt: now
    })
    .returning();

  return { thread: thread!, message: msg! };
}

describe('thread followers', () => {
  test('can follow and unfollow a thread', async () => {
    const forum = await createForumChannel();
    const { thread } = await createForumPost(forum.id);

    // Follow
    await tdb.insert(threadFollowers).values({
      threadId: thread.id,
      userId: 1,
      createdAt: Date.now()
    });

    const followers = await tdb
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, thread.id));
    expect(followers.length).toBe(1);
    expect(followers[0]!.userId).toBe(1);

    // Unfollow
    await tdb
      .delete(threadFollowers)
      .where(
        and(
          eq(threadFollowers.threadId, thread.id),
          eq(threadFollowers.userId, 1)
        )
      );

    const followersAfter = await tdb
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, thread.id));
    expect(followersAfter.length).toBe(0);
  });

  test('duplicate follow is idempotent with onConflictDoNothing', async () => {
    const forum = await createForumChannel();
    const { thread } = await createForumPost(forum.id);

    await tdb.insert(threadFollowers).values({
      threadId: thread.id,
      userId: 1,
      createdAt: Date.now()
    });

    // Insert again with onConflictDoNothing
    await tdb
      .insert(threadFollowers)
      .values({
        threadId: thread.id,
        userId: 1,
        createdAt: Date.now()
      })
      .onConflictDoNothing();

    const followers = await tdb
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, thread.id));
    expect(followers.length).toBe(1);
  });

  test('deleting thread cascades to followers', async () => {
    const forum = await createForumChannel();
    const { thread } = await createForumPost(forum.id);

    await tdb.insert(threadFollowers).values({
      threadId: thread.id,
      userId: 1,
      createdAt: Date.now()
    });

    const before = await tdb
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, thread.id));
    expect(before.length).toBe(1);

    // Delete the thread channel
    await tdb.delete(channels).where(eq(channels.id, thread.id));

    const after = await tdb
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, thread.id));
    expect(after.length).toBe(0);
  });

  test('multiple users can follow the same thread', async () => {
    const forum = await createForumChannel();
    const { thread } = await createForumPost(forum.id);

    await tdb.insert(threadFollowers).values([
      { threadId: thread.id, userId: 1, createdAt: Date.now() },
      { threadId: thread.id, userId: 2, createdAt: Date.now() },
      { threadId: thread.id, userId: 3, createdAt: Date.now() }
    ]);

    const followers = await tdb
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, thread.id));
    expect(followers.length).toBe(3);
  });
});

describe('forum post tags', () => {
  test('can add and remove tags from a post', async () => {
    const forum = await createForumChannel();
    const { thread } = await createForumPost(forum.id);

    // Create tags
    const [tag1] = await tdb
      .insert(forumTags)
      .values({
        channelId: forum.id,
        name: 'Bug',
        color: '#ff0000',
        createdAt: Date.now()
      })
      .returning();

    const [tag2] = await tdb
      .insert(forumTags)
      .values({
        channelId: forum.id,
        name: 'Feature',
        color: '#00ff00',
        createdAt: Date.now()
      })
      .returning();

    // Assign tags
    await tdb.insert(forumPostTags).values([
      { threadId: thread.id, tagId: tag1!.id },
      { threadId: thread.id, tagId: tag2!.id }
    ]);

    const tagsBefore = await tdb
      .select()
      .from(forumPostTags)
      .where(eq(forumPostTags.threadId, thread.id));
    expect(tagsBefore.length).toBe(2);

    // Remove all tags
    await tdb
      .delete(forumPostTags)
      .where(eq(forumPostTags.threadId, thread.id));

    // Add only one tag back
    await tdb.insert(forumPostTags).values({
      threadId: thread.id,
      tagId: tag1!.id
    });

    const tagsAfter = await tdb
      .select()
      .from(forumPostTags)
      .where(eq(forumPostTags.threadId, thread.id));
    expect(tagsAfter.length).toBe(1);
    expect(tagsAfter[0]!.tagId).toBe(tag1!.id);
  });

  test('deleting a forum post cascades to its tags', async () => {
    const forum = await createForumChannel();
    const { thread } = await createForumPost(forum.id);

    const [tag] = await tdb
      .insert(forumTags)
      .values({
        channelId: forum.id,
        name: 'Test',
        color: '#000',
        createdAt: Date.now()
      })
      .returning();

    await tdb.insert(forumPostTags).values({
      threadId: thread.id,
      tagId: tag!.id
    });

    // Delete the thread
    await tdb.delete(channels).where(eq(channels.id, thread.id));

    const tagsAfter = await tdb
      .select()
      .from(forumPostTags)
      .where(eq(forumPostTags.threadId, thread.id));
    expect(tagsAfter.length).toBe(0);
  });
});

describe('forum post deletion', () => {
  test('deleting a forum post cascades to messages, tags, and followers', async () => {
    const forum = await createForumChannel();
    const { thread } = await createForumPost(forum.id);

    // Add a tag
    const [tag] = await tdb
      .insert(forumTags)
      .values({
        channelId: forum.id,
        name: 'Cascade Test',
        color: '#abc',
        createdAt: Date.now()
      })
      .returning();

    await tdb.insert(forumPostTags).values({
      threadId: thread.id,
      tagId: tag!.id
    });

    // Add a follower
    await tdb.insert(threadFollowers).values({
      threadId: thread.id,
      userId: 1,
      createdAt: Date.now()
    });

    // Add a reply message
    await tdb.insert(messages).values({
      content: 'Reply',
      userId: 2,
      channelId: thread.id,
      createdAt: Date.now()
    });

    // Verify data exists
    const msgsBefore = await tdb
      .select()
      .from(messages)
      .where(eq(messages.channelId, thread.id));
    expect(msgsBefore.length).toBe(2); // initial + reply

    // Delete the thread
    await tdb.delete(channels).where(eq(channels.id, thread.id));

    // Verify cascades
    const msgsAfter = await tdb
      .select()
      .from(messages)
      .where(eq(messages.channelId, thread.id));
    expect(msgsAfter.length).toBe(0);

    const tagsAfter = await tdb
      .select()
      .from(forumPostTags)
      .where(eq(forumPostTags.threadId, thread.id));
    expect(tagsAfter.length).toBe(0);

    const followersAfter = await tdb
      .select()
      .from(threadFollowers)
      .where(eq(threadFollowers.threadId, thread.id));
    expect(followersAfter.length).toBe(0);

    // Forum channel still exists
    const [forumAfter] = await tdb
      .select()
      .from(channels)
      .where(eq(channels.id, forum.id));
    expect(forumAfter).toBeTruthy();
  });
});

describe('mention parsing in forum posts', () => {
  test('initial post message can store mentionedUserIds', async () => {
    const forum = await createForumChannel();
    const now = Date.now();

    const [thread] = await tdb
      .insert(channels)
      .values({
        type: ChannelType.THREAD,
        name: 'Mention Test',
        position: 0,
        fileAccessToken: randomUUIDv7(),
        fileAccessTokenUpdatedAt: now,
        serverId: 1,
        parentChannelId: forum.id,
        createdAt: now
      })
      .returning();

    // Create message with mentions
    const [msg] = await tdb
      .insert(messages)
      .values({
        content: 'Hey <@2> check this out',
        userId: 1,
        channelId: thread!.id,
        mentionedUserIds: [2],
        mentionsAll: false,
        createdAt: now
      })
      .returning();

    expect(msg!.mentionedUserIds).toEqual([2]);
    expect(msg!.mentionsAll).toBe(false);
  });
});
