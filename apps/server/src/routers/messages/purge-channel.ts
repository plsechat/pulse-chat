import { Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { channels, messageFiles, messages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const purgeChannelRoute = protectedProcedure
  .input(
    z.object({
      channelId: z.number(),
      confirmChannelName: z.string()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_MESSAGES);

    const [channel] = await db
      .select({ id: channels.id, name: channels.name })
      .from(channels)
      .where(eq(channels.id, input.channelId))
      .limit(1);

    invariant(channel, {
      code: 'NOT_FOUND',
      message: 'Channel not found'
    });

    invariant(channel.name === input.confirmChannelName, {
      code: 'BAD_REQUEST',
      message: 'Channel name does not match'
    });

    // Get all file IDs for messages in this channel
    const fileRows = await db
      .select({ fileId: messageFiles.fileId })
      .from(messageFiles)
      .innerJoin(messages, eq(messageFiles.messageId, messages.id))
      .where(eq(messages.channelId, input.channelId));

    for (const row of fileRows) {
      await removeFile(row.fileId);
    }

    await db.delete(messages).where(eq(messages.channelId, input.channelId));

    pubsub.publish(ServerEvents.MESSAGE_BULK_DELETE, {
      messageIds: [],
      channelId: input.channelId,
      purged: true
    });

    return { success: true };
  });

export { purgeChannelRoute };
