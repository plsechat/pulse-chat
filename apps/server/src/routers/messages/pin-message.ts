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

const pinMessageRoute = serverProcedure(Permission.PIN_MESSAGES)
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

    // Server scope alone still lets a member pin inside a private
    // channel they cannot view (and learn the message exists).
    await ctx.needsChannelPermission(
      message.channelId,
      ChannelPermission.VIEW_CHANNEL
    );

    invariant(!message.deletedAt, {
      code: 'BAD_REQUEST',
      message: 'This message was deleted'
    });

    invariant(!message.pinned, {
      code: 'BAD_REQUEST',
      message: 'Message is already pinned'
    });

    await db
      .update(messages)
      .set({
        pinned: true,
        pinnedAt: Date.now(),
        pinnedBy: ctx.user.id
      })
      .where(eq(messages.id, input.messageId));

    publishMessage(input.messageId, message.channelId, 'update');

    const affectedUserIds = await getAffectedUserIdsForChannel(
      message.channelId,
      { permission: ChannelPermission.VIEW_CHANNEL }
    );

    ctx.pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_PIN, {
      messageId: input.messageId,
      channelId: message.channelId,
      pinnedBy: ctx.user.id
    });
  });

export { pinMessageRoute };
