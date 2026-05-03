import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channels, messageFiles, messages } from '../../db/schema';
import { eventBus } from '../../plugins/event-bus';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const bulkDeleteMessagesRoute = protectedProcedure
  .input(
    z.object({
      messageIds: z.array(z.number()).min(1).max(100)
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_MESSAGES);

    // Join channels so we only return messages in the caller's active server.
    // Without this filter, MANAGE_MESSAGES in server A could bulk-delete from
    // any channel in server B.
    const targetMessages = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          inArray(messages.id, input.messageIds),
          eq(channels.serverId, ctx.activeServerId!)
        )
      );

    invariant(targetMessages.length > 0, {
      code: 'NOT_FOUND',
      message: 'No messages found'
    });

    const channelId = targetMessages[0]!.channelId;
    const allSameChannel = targetMessages.every(
      (m) => m.channelId === channelId
    );
    invariant(allSameChannel, {
      code: 'BAD_REQUEST',
      message: 'All messages must belong to the same channel'
    });

    const foundIds = targetMessages.map((m) => m.id);

    // Batch file cleanup
    const fileRows = await db
      .select({ fileId: messageFiles.fileId })
      .from(messageFiles)
      .where(inArray(messageFiles.messageId, foundIds));

    for (const row of fileRows) {
      await removeFile(row.fileId);
    }

    await db.delete(messages).where(inArray(messages.id, foundIds));

    const affectedUserIds = await getAffectedUserIdsForChannel(channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_BULK_DELETE, {
      messageIds: foundIds,
      channelId
    });

    for (const id of foundIds) {
      eventBus.emit('message:deleted', { channelId, messageId: id });
    }

    return { deletedCount: foundIds.length };
  });

export { bulkDeleteMessagesRoute };
