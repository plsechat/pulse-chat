import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { and, count, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { channels, messages } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';
import { pubsub } from '../../utils/pubsub';
import { getThreadViewerIds } from './_shared';

const archiveThreadRoute = serverProcedure()
  .input(
    z.object({
      threadId: z.number().int().positive(),
      archived: z.boolean()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Scope to active server so a user with MANAGE_CHANNELS in server B
    // can't archive a thread in server A (audit recurring rule:
    // pulse-rule-cross-server-scope).
    const [thread] = await db
      .select()
      .from(channels)
      .where(
        and(
          eq(channels.id, input.threadId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
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

    const viewerIds = await getThreadViewerIds(thread.id);
    pubsub.publishFor(viewerIds, ServerEvents.THREAD_UPDATE, {
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
