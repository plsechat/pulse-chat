import { ChannelType } from '@pulse/shared';
import { and, count, desc, eq, max, min } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db } from '../../db';
import { channels, messages } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';

const getThreadsRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      includeArchived: z.boolean().optional().default(false)
    })
  )
  .query(async ({ input }) => {
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

    return threads.map((t) => ({
      id: t.id,
      name: t.name,
      messageCount: t.messageCount,
      lastMessageAt: t.lastMessageAt ? Number(t.lastMessageAt) : null,
      archived: t.archived,
      parentChannelId: t.parentChannelId!,
      createdAt: t.createdAt,
      sourceMessageId: t.sourceMessageId
    }));
  });

export { getThreadsRoute };
