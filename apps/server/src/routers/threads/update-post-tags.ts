import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { and, count, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { channels, forumPostTags, messages } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';
import { pubsub } from '../../utils/pubsub';
import {
  getThreadViewerIds,
  MAX_TAGS_PER_POST,
  resolveForumTagIds
} from './_shared';

const updatePostTagsRoute = serverProcedure()
  .input(
    z.object({
      threadId: z.number().int().positive(),
      tagIds: z.array(z.number().int().positive()).max(MAX_TAGS_PER_POST)
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [thread] = await db
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        serverId: channels.serverId,
        parentChannelId: channels.parentChannelId,
        archived: channels.archived
      })
      .from(channels)
      .where(
        and(
          eq(channels.id, input.threadId),
          eq(channels.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    if (
      !thread ||
      thread.type !== ChannelType.THREAD ||
      thread.parentChannelId === null
    ) {
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

    // Tags must be the parent forum's own.
    const tagIds = await resolveForumTagIds(
      thread.parentChannelId,
      input.tagIds
    );

    await db.transaction(async (tx) => {
      // Remove existing tags
      await tx
        .delete(forumPostTags)
        .where(eq(forumPostTags.threadId, input.threadId));

      // Insert new tags
      if (tagIds.length > 0) {
        await tx.insert(forumPostTags).values(
          tagIds.map((tagId) => ({
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

    const viewerIds = await getThreadViewerIds(thread.id);
    pubsub.publishFor(viewerIds, ServerEvents.THREAD_UPDATE, {
      id: thread.id,
      name: thread.name,
      messageCount: stats?.messageCount ?? 0,
      lastMessageAt: stats?.lastMessageAt ? Number(stats.lastMessageAt) : null,
      // the row's real flag: a hard-coded false made every tag edit on an
      // archived post look like it had been reopened
      archived: thread.archived,
      parentChannelId: thread.parentChannelId,
      creatorId: firstMsg?.userId ?? 0
    });
  });

export { updatePostTagsRoute };
