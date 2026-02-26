import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { count, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels, forumPostTags, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const updatePostTagsRoute = protectedProcedure
  .input(
    z.object({
      threadId: z.number(),
      tagIds: z.array(z.number())
    })
  )
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

    // Check if user is the post creator (first message author)
    const [firstMsg] = await db
      .select({ userId: messages.userId })
      .from(messages)
      .where(eq(messages.channelId, input.threadId))
      .orderBy(messages.createdAt)
      .limit(1);

    const isCreator = firstMsg?.userId === ctx.userId;

    if (isCreator) {
      await ctx.needsPermission(Permission.SEND_MESSAGES, thread.serverId);
    } else {
      await ctx.needsPermission(Permission.MANAGE_CHANNELS, thread.serverId);
    }

    await db.transaction(async (tx) => {
      // Remove existing tags
      await tx
        .delete(forumPostTags)
        .where(eq(forumPostTags.threadId, input.threadId));

      // Insert new tags
      if (input.tagIds.length > 0) {
        await tx.insert(forumPostTags).values(
          input.tagIds.map((tagId) => ({
            threadId: input.threadId,
            tagId
          }))
        );
      }
    });

    // Publish THREAD_UPDATE so other clients refresh
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
      archived: false,
      parentChannelId: thread.parentChannelId!,
      creatorId: firstMsg?.userId ?? 0
    });
  });

export { updatePostTagsRoute };
