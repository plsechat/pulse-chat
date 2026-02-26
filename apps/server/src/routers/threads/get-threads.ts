import { ChannelPermission, ChannelType } from '@pulse/shared';
import { and, asc, count, desc, eq, inArray, max, min } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db';
import {
  channels,
  files,
  forumPostTags,
  forumTags,
  messageFiles,
  messageReactions,
  messages,
  users
} from '../../db/schema';
import { getPlainTextFromHtml } from '../../helpers/get-plain-text-from-html';
import { protectedProcedure } from '../../utils/trpc';

const getThreadsRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      includeArchived: z.boolean().optional().default(false)
    })
  )
  .query(async ({ ctx, input }) => {
    // Verify the caller has access to the parent channel
    await ctx.needsChannelPermission(
      input.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    const conditions = [
      eq(channels.parentChannelId, input.channelId),
      eq(channels.type, ChannelType.THREAD)
    ];

    if (!input.includeArchived) {
      conditions.push(eq(channels.archived, false));
    }

    // sourceMessages: the message in the parent channel whose threadId points
    // to this thread — i.e. the message that originally spawned the thread.
    const sourceMessages = alias(messages, 'sourceMessages');

    const threads = await db
      .select({
        id: channels.id,
        name: channels.name,
        archived: channels.archived,
        parentChannelId: channels.parentChannelId,
        createdAt: channels.createdAt,
        messageCount: count(messages.id),
        lastMessageAt: max(messages.createdAt),
        sourceMessageId: min(sourceMessages.id)
      })
      .from(channels)
      .leftJoin(messages, eq(messages.channelId, channels.id))
      .leftJoin(sourceMessages, eq(sourceMessages.threadId, channels.id))
      .where(and(...conditions))
      .groupBy(channels.id)
      .orderBy(desc(channels.createdAt));

    if (threads.length === 0) return [];

    const threadIds = threads.map((t) => t.id);

    // Get first message (the original post) for each thread
    const firstMessages = await db
      .select({
        channelId: messages.channelId,
        content: messages.content,
        userId: messages.userId,
        id: messages.id
      })
      .from(messages)
      .where(inArray(messages.channelId, threadIds))
      .orderBy(asc(messages.createdAt));

    // Deduplicate to get only the first message per thread
    const firstMessageByThread = new Map<
      number,
      { content: string | null; userId: number; id: number }
    >();
    for (const msg of firstMessages) {
      if (!firstMessageByThread.has(msg.channelId)) {
        firstMessageByThread.set(msg.channelId, {
          content: msg.content,
          userId: msg.userId,
          id: msg.id
        });
      }
    }

    // Get creator user info
    const creatorIds = [
      ...new Set(
        [...firstMessageByThread.values()].map((m) => m.userId)
      )
    ];

    const creatorUsers =
      creatorIds.length > 0
        ? await db
            .select({
              id: users.id,
              name: users.name,
              avatarId: users.avatarId
            })
            .from(users)
            .where(inArray(users.id, creatorIds))
        : [];

    const creatorMap = new Map(creatorUsers.map((u) => [u.id, u]));

    // Get first image file for each thread's first message
    const firstMessageIds = [...firstMessageByThread.values()].map(
      (m) => m.id
    );

    const imageFiles =
      firstMessageIds.length > 0
        ? await db
            .select({
              messageId: messageFiles.messageId,
              fileName: files.name,
              mimeType: files.mimeType
            })
            .from(messageFiles)
            .innerJoin(files, eq(messageFiles.fileId, files.id))
            .where(inArray(messageFiles.messageId, firstMessageIds))
        : [];

    const firstImageByMessage = new Map<string, string>();
    for (const f of imageFiles) {
      if (
        f.mimeType.startsWith('image/') &&
        !firstImageByMessage.has(String(f.messageId))
      ) {
        firstImageByMessage.set(String(f.messageId), f.fileName);
      }
    }

    // Get tags for each thread
    const threadTags = await db
      .select({
        threadId: forumPostTags.threadId,
        tagId: forumTags.id,
        tagName: forumTags.name,
        tagColor: forumTags.color
      })
      .from(forumPostTags)
      .innerJoin(forumTags, eq(forumPostTags.tagId, forumTags.id))
      .where(inArray(forumPostTags.threadId, threadIds));

    const tagsByThread = new Map<
      number,
      { id: number; name: string; color: string }[]
    >();
    for (const tag of threadTags) {
      const existing = tagsByThread.get(tag.threadId) ?? [];
      existing.push({
        id: tag.tagId,
        name: tag.tagName,
        color: tag.tagColor
      });
      tagsByThread.set(tag.threadId, existing);
    }

    // Get reactions on each thread's first message
    const reactionRows =
      firstMessageIds.length > 0
        ? await db
            .select({
              messageId: messageReactions.messageId,
              emoji: messageReactions.emoji,
              reactionCount: count(messageReactions.userId)
            })
            .from(messageReactions)
            .where(inArray(messageReactions.messageId, firstMessageIds))
            .groupBy(messageReactions.messageId, messageReactions.emoji)
        : [];

    // Build a map: messageId -> [{ emoji, count }]
    const reactionsByMessage = new Map<
      number,
      { emoji: string; count: number }[]
    >();
    for (const row of reactionRows) {
      const existing = reactionsByMessage.get(row.messageId) ?? [];
      existing.push({ emoji: row.emoji, count: row.reactionCount });
      reactionsByMessage.set(row.messageId, existing);
    }

    return threads.map((t) => {
      const firstMsg = firstMessageByThread.get(t.id);
      const creator = firstMsg ? creatorMap.get(firstMsg.userId) : undefined;
      const firstImage = firstMsg
        ? firstImageByMessage.get(String(firstMsg.id))
        : undefined;

      const contentPreview = firstMsg?.content
        ? getPlainTextFromHtml(firstMsg.content).slice(0, 200)
        : undefined;

      const reactions = firstMsg
        ? reactionsByMessage.get(firstMsg.id) ?? []
        : [];

      return {
        id: t.id,
        name: t.name,
        messageCount: t.messageCount,
        lastMessageAt: t.lastMessageAt ? Number(t.lastMessageAt) : null,
        archived: t.archived,
        parentChannelId: t.parentChannelId!,
        createdAt: t.createdAt,
        sourceMessageId: t.sourceMessageId,
        creatorId: firstMsg?.userId,
        creatorName: creator?.name,
        creatorAvatarId: creator?.avatarId,
        contentPreview,
        firstImage,
        tags: tagsByThread.get(t.id) ?? [],
        reactions
      };
    });
  });

export { getThreadsRoute };
