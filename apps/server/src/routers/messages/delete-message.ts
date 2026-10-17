import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { tombstoneMessages } from '../../db/mutations/messages';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { getMessageInActiveServer } from '../../db/queries/messages';
import { eventBus } from '../../plugins/event-bus';
import { relayAnnouncementDeletion } from '../../utils/announcement-follow';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

// No server permission up front: authors may delete their own messages;
// everyone else needs MANAGE_MESSAGES (checked once the row is loaded).
const deleteMessageRoute = serverProcedure()
  .input(z.object({ messageId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    const targetMessage = await getMessageInActiveServer(
      input.messageId,
      ctx.activeServerId
    );

    invariant(targetMessage, {
      code: 'NOT_FOUND',
      message: 'Message not found'
    });
    invariant(
      targetMessage.userId === ctx.user.id ||
        (await ctx.hasPermission(Permission.MANAGE_MESSAGES)),
      {
        code: 'FORBIDDEN',
        message: 'You do not have permission to delete this message'
      }
    );
    invariant(!targetMessage.deletedAt, {
      code: 'BAD_REQUEST',
      message: 'Message is already deleted'
    });

    // The row stays as a tombstone; attachments, reactions, metadata and
    // the pin go now (db/mutations/messages.ts).
    const deletedAt = Date.now();
    await tombstoneMessages([input.messageId], ctx.user.id, deletedAt);
    const tombstone = { deletedAt, deletedBy: ctx.user.id };

    publishMessage(input.messageId, targetMessage.channelId, 'delete', tombstone);

    // The pin is gone with the content: pinned lists refetch on this.
    if (targetMessage.pinned) {
      const viewers = await getAffectedUserIdsForChannel(
        targetMessage.channelId,
        { permission: ChannelPermission.VIEW_CHANNEL }
      );
      ctx.pubsub.publishFor(viewers, ServerEvents.MESSAGE_UNPIN, {
        messageId: input.messageId,
        channelId: targetMessage.channelId
      });
    }

    void relayAnnouncementDeletion(
      targetMessage.channelId,
      [input.messageId],
      tombstone
    );

    eventBus.emit('message:deleted', {
      channelId: targetMessage.channelId,
      messageId: input.messageId
    });
  });

export { deleteMessageRoute };
