import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { tombstoneMessages } from '../../db/mutations/messages';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channels, messages } from '../../db/schema';
import { eventBus } from '../../plugins/event-bus';
import { relayAnnouncementDeletion } from '../../utils/announcement-follow';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { pubsub } from '../../utils/pubsub';

const bulkDeleteMessagesRoute = serverProcedure(Permission.MANAGE_MESSAGES)
  .input(
    z.object({
      messageIds: z.array(z.number().int().positive()).min(1).max(100)
    })
  )
  .mutation(async ({ input, ctx }) => {
    // Join channels so we only return messages in the caller's active server.
    // Without this filter, MANAGE_MESSAGES in server A could bulk-delete from
    // any channel in server B. Rows that are already tombstones are not
    // "found": deleting them again would only move the deletion's author
    // and time.
    const targetMessages = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          inArray(messages.id, input.messageIds),
          eq(channels.serverId, ctx.activeServerId),
          isNull(messages.deletedAt)
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

    // Tombstones, with the attachments removed inside (db/mutations/messages.ts).
    const deletedAt = Date.now();
    const foundIds = await tombstoneMessages(
      targetMessages.map((m) => m.id),
      ctx.user.id,
      deletedAt
    );
    const tombstone = { deletedAt, deletedBy: ctx.user.id };

    const affectedUserIds = await getAffectedUserIdsForChannel(channelId, {
      permission: ChannelPermission.VIEW_CHANNEL
    });
    pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_BULK_DELETE, {
      messageIds: foundIds,
      channelId,
      ...tombstone
    });

    for (const id of foundIds) {
      eventBus.emit('message:deleted', { channelId, messageId: id });
    }
    void relayAnnouncementDeletion(channelId, foundIds, tombstone);

    return { deletedCount: foundIds.length };
  });

export { bulkDeleteMessagesRoute };
