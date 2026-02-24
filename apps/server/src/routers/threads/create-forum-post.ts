import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel, publishMessage } from '../../db/publishers';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels, forumPostTags, messageFiles, messages } from '../../db/schema';
import { fileManager } from '../../utils/file-manager';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const createForumPostRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(4000),
      tagIds: z.array(z.number()).optional(),
      files: z.array(z.string()).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Verify the channel exists and is a FORUM type
    const [forumChannel] = await db
      .select({
        id: channels.id,
        type: channels.type,
        serverId: channels.serverId
      })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .limit(1);

    if (!forumChannel || forumChannel.type !== ChannelType.FORUM) {
      return ctx.throwValidationError('channelId', 'Forum channel not found');
    }

    await ctx.needsPermission(Permission.SEND_MESSAGES, forumChannel.serverId);

    const now = Date.now();

    const result = await db.transaction(async (tx) => {
      // Create thread channel for the forum post
      const [thread] = await tx
        .insert(channels)
        .values({
          type: ChannelType.THREAD,
          name: input.title,
          position: 0,
          fileAccessToken: randomUUIDv7(),
          fileAccessTokenUpdatedAt: now,
          serverId: forumChannel.serverId,
          parentChannelId: forumChannel.id,
          archived: false,
          autoArchiveDuration: 1440,
          createdAt: now
        })
        .returning();

      // Create the initial message in the thread
      const [firstMessage] = await tx
        .insert(messages)
        .values({
          content: input.content,
          userId: ctx.userId,
          channelId: thread!.id,
          createdAt: now
        })
        .returning();

      // Attach tags if provided
      if (input.tagIds && input.tagIds.length > 0) {
        await tx.insert(forumPostTags).values(
          input.tagIds.map((tagId) => ({
            threadId: thread!.id,
            tagId
          }))
        );
      }

      return { thread: thread!, message: firstMessage! };
    });

    // Attach files to the initial message
    if (input.files && input.files.length > 0) {
      for (const tempFileId of input.files) {
        const newFile = await fileManager.saveFile(tempFileId, ctx.userId);

        await db.insert(messageFiles).values({
          messageId: result.message.id,
          fileId: newFile.id,
          createdAt: Date.now()
        });
      }
    }

    // Publish events
    publishChannel(result.thread.id, 'create');
    publishMessage(result.message.id, result.thread.id, 'create');

    const memberIds = await getServerMemberIds(forumChannel.serverId);
    pubsub.publishFor(memberIds, ServerEvents.THREAD_CREATE, {
      id: result.thread.id,
      name: result.thread.name,
      messageCount: 1,
      lastMessageAt: now,
      archived: false,
      parentChannelId: forumChannel.id,
      creatorId: ctx.userId
    });

    return { threadId: result.thread.id };
  });

export { createForumPostRoute };
