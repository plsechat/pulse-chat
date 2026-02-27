import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const deleteThreadRoute = protectedProcedure
  .input(z.object({ threadId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    const [thread] = await db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        serverId: channels.serverId,
        parentChannelId: channels.parentChannelId
      })
      .from(channels)
      .where(eq(channels.id, input.threadId))
      .limit(1);

    if (!thread || thread.type !== ChannelType.THREAD) {
      return ctx.throwValidationError('threadId', 'Thread not found');
    }

    // Allow deletion by thread creator or users with MANAGE_CHANNELS
    const hasManagePermission = await ctx.hasPermission(Permission.MANAGE_CHANNELS, thread.serverId);

    if (!hasManagePermission) {
      const [firstMessage] = await db
        .select({ userId: messages.userId })
        .from(messages)
        .where(eq(messages.channelId, input.threadId))
        .orderBy(asc(messages.createdAt))
        .limit(1);

      if (!firstMessage || firstMessage.userId !== ctx.userId) {
        await ctx.needsPermission(Permission.MANAGE_CHANNELS, thread.serverId);
      }
    }

    // Delete the thread channel (cascades to messages, forumPostTags, threadFollowers)
    await db.delete(channels).where(eq(channels.id, input.threadId));

    publishChannel(input.threadId, 'delete', thread.serverId);

    const memberIds = await getServerMemberIds(thread.serverId);
    pubsub.publishFor(memberIds, ServerEvents.THREAD_DELETE, input.threadId);
  });

export { deleteThreadRoute };
