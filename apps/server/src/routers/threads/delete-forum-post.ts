import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const deleteForumPostRoute = protectedProcedure
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

    // Verify parent is a FORUM channel
    if (thread.parentChannelId) {
      const [parent] = await db
        .select({ type: channels.type })
        .from(channels)
        .where(eq(channels.id, thread.parentChannelId))
        .limit(1);

      if (!parent || parent.type !== ChannelType.FORUM) {
        return ctx.throwValidationError('threadId', 'Not a forum post');
      }
    }

    await ctx.needsPermission(Permission.MANAGE_CHANNELS, thread.serverId);

    // Delete the thread channel (cascades to messages, forumPostTags, threadFollowers)
    await db.delete(channels).where(eq(channels.id, input.threadId));

    publishChannel(input.threadId, 'delete', thread.serverId);

    const memberIds = await getServerMemberIds(thread.serverId);
    pubsub.publishFor(memberIds, ServerEvents.THREAD_DELETE, input.threadId);
  });

export { deleteForumPostRoute };
