import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { count, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const archiveThreadRoute = protectedProcedure
  .input(
    z.object({
      threadId: z.number(),
      archived: z.boolean()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [thread] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, input.threadId))
      .limit(1);

    if (!thread || thread.type !== ChannelType.THREAD) {
      return ctx.throwValidationError('threadId', 'Thread not found');
    }

    await ctx.needsPermission(Permission.MANAGE_CHANNELS, thread.serverId);

    await db
      .update(channels)
      .set({ archived: input.archived, updatedAt: Date.now() })
      .where(eq(channels.id, input.threadId));

    publishChannel(input.threadId, 'update');

    // Get thread stats for the event
    const [stats] = await db
      .select({
        messageCount: count(messages.id),
        lastMessageAt: max(messages.createdAt)
      })
      .from(messages)
      .where(eq(messages.channelId, input.threadId));

    const memberIds = await getServerMemberIds(thread.serverId);
    pubsub.publishFor(memberIds, ServerEvents.THREAD_UPDATE, {
      id: thread.id,
      name: thread.name,
      messageCount: stats?.messageCount ?? 0,
      lastMessageAt: stats?.lastMessageAt ? Number(stats.lastMessageAt) : null,
      archived: input.archived,
      parentChannelId: thread.parentChannelId!,
      creatorId: 0
    });
  });

export { archiveThreadRoute };
