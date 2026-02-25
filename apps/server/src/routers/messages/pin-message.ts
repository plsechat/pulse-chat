import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishMessage } from '../../db/publishers';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { channels, messages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const pinMessageRoute = protectedProcedure
  .input(
    z.object({
      messageId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.PIN_MESSAGES);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const [message] = await db
      .select({
        id: messages.id,
        channelId: messages.channelId,
        pinned: messages.pinned
      })
      .from(messages)
      .innerJoin(channels, eq(messages.channelId, channels.id))
      .where(and(eq(messages.id, input.messageId), eq(channels.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(message, {
      code: 'NOT_FOUND',
      message: 'Message not found'
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
