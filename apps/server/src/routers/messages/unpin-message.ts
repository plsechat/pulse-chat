import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { getMessageInActiveServer } from '../../db/queries/messages';
import { messages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const unpinMessageRoute = serverProcedure(Permission.PIN_MESSAGES)
  .input(
    z.object({
      messageId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const message = await getMessageInActiveServer(
      input.messageId,
      ctx.activeServerId
    );

    invariant(message, {
      code: 'NOT_FOUND',
      message: 'Message not found'
    });

    // Server scope alone still lets a member unpin inside a private
    // channel they cannot view (and learn the message exists).
    await ctx.needsChannelPermission(
      message.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    invariant(message.pinned, {
      code: 'BAD_REQUEST',
      message: 'Message is not pinned'
    });

    await db
      .update(messages)
      .set({
        pinned: false,
        pinnedAt: null,
        pinnedBy: null
      })
      .where(eq(messages.id, input.messageId));

    publishMessage(input.messageId, message.channelId, 'update');

    const affectedUserIds = await getAffectedUserIdsForChannel(
      message.channelId,
      { permission: ChannelPermission.VIEW_CHANNEL }
    );

    ctx.pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_UNPIN, {
      messageId: input.messageId,
      channelId: message.channelId
    });
  });

export { unpinMessageRoute };
