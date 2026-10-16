import {
  ChannelPermission,
  ChannelType,
  Permission,
  ServerEvents
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel, publishMessage } from '../../db/publishers';
import { getMessageInActiveServer } from '../../db/queries/messages';
import { channels, messages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { pubsub } from '../../utils/pubsub';
import {
  assertThreadableParent,
  copyParentOverrides,
  getThreadViewerIds,
  publishPrivateThreadPermissions
} from './_shared';

const createThreadRoute = serverProcedure(Permission.SEND_MESSAGES)
  .input(
    z.object({
      messageId: z.number().int().positive(),
      name: z.string().min(1).max(100)
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Scoped to the active server: a message elsewhere reads as not
    // found, so a SEND_MESSAGES holder here can't spawn threads on
    // messages in servers they are not active in.
    const message = await getMessageInActiveServer(
      input.messageId,
      ctx.activeServerId
    );

    if (!message) {
      return ctx.throwValidationError('messageId', 'Message not found');
    }

    if (message.threadId) {
      return ctx.throwValidationError('messageId', 'Message already has a thread');
    }

    const [parentChannel] = await db
      .select()
      .from(channels)
      .where(eq(channels.id, message.channelId))
      .limit(1);

    invariant(parentChannel, {
      code: 'NOT_FOUND',
      message: 'Parent channel not found'
    });

    assertThreadableParent(parentChannel);

    // Channel-level check (implies VIEW): the server-level SEND_MESSAGES
    // the builder verified says nothing about a private parent.
    await ctx.needsChannelPermission(
      parentChannel.id,
      ChannelPermission.SEND_MESSAGES
    );

    const now = Date.now();

    const thread = await db.transaction(async (tx) => {
      // Create a channel of type THREAD. Encryption and visibility are
      // inherited: a plaintext/public thread under an encrypted/private
      // parent would leak what the parent protects.
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
          private: parentChannel.private,
          e2ee: parentChannel.e2ee,
          archived: false,
          autoArchiveDuration: 1440,
          publicId: randomUUIDv7(),
          createdAt: now
        })
        .returning();

      if (parentChannel.private) {
        await copyParentOverrides(tx, parentChannel.id, newThread!.id, now);
      }

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

    // Thread-specific event to everyone who can view the thread
    const viewerIds = await getThreadViewerIds(thread.id);
    await publishPrivateThreadPermissions(parentChannel.private, viewerIds);
    pubsub.publishFor(viewerIds, ServerEvents.THREAD_CREATE, {
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
