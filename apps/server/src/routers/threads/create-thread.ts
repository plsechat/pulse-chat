import { ChannelType, Permission, ServerEvents } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel, publishMessage } from '../../db/publishers';
import { getServerMemberIds } from '../../db/queries/servers';
import { channels, messages } from '../../db/schema';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const createThreadRoute = protectedProcedure
  .input(
    z.object({
      messageId: z.number(),
      name: z.string().min(1).max(100)
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Fetch the source message
    const [message] = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        threadId: messages.threadId
      })
      .from(messages)
      .where(eq(messages.id, input.messageId))
      .limit(1);

    if (!message) {
      return ctx.throwValidationError('messageId', 'Message not found');
    }

    if (message.threadId) {
      return ctx.throwValidationError('messageId', 'Message already has a thread');
    }

    // Get the parent channel to inherit serverId
    const [parentChannel] = await db
      .select({
        id: channels.id,
        serverId: channels.serverId
      })
      .from(channels)
      .where(eq(channels.id, message.channelId))
      .limit(1);

    if (!parentChannel) {
      return ctx.throwValidationError('messageId', 'Parent channel not found');
    }

    await ctx.needsPermission(Permission.SEND_MESSAGES, parentChannel.serverId);

    const now = Date.now();

    const thread = await db.transaction(async (tx) => {
      // Create a channel of type THREAD
      const [newThread] = await tx
        .insert(channels)
        .values({
          type: ChannelType.THREAD,
          name: input.name,
          position: 0,
          fileAccessToken: randomUUIDv7(),
          fileAccessTokenUpdatedAt: now,
          serverId: parentChannel.serverId,
          parentChannelId: parentChannel.id,
          archived: false,
          autoArchiveDuration: 1440,
          createdAt: now
        })
        .returning();

      // Link the source message to this thread
      await tx
        .update(messages)
        .set({ threadId: newThread!.id })
        .where(eq(messages.id, input.messageId));

      return newThread!;
    });

    // Publish channel creation (thread appears as a new channel)
    publishChannel(thread.id, 'create');

    // Publish message update so clients see the threadId indicator
    publishMessage(input.messageId, message.channelId, 'update');

    // Publish thread-specific event to server members
    const memberIds = await getServerMemberIds(parentChannel.serverId);
    pubsub.publishFor(memberIds, ServerEvents.THREAD_CREATE, {
      id: thread.id,
      name: thread.name,
      messageCount: 0,
      lastMessageAt: null,
      archived: false,
      parentChannelId: parentChannel.id,
      creatorId: ctx.userId
    });

    return { threadId: thread.id };
  });

export { createThreadRoute };
