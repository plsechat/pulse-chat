import { ChannelPermission, ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { getAffectedUserIdsForChannel } from '../../db/queries/channels';
import { protectedProcedure } from '../../utils/trpc';

const signalTypingRoute = protectedProcedure
  .input(
    z
      .object({
        channelId: z.number()
      })
      .required()
  )
  .mutation(async ({ input, ctx }) => {
    const affectedUserIds = await getAffectedUserIdsForChannel(
      input.channelId,
      { permission: ChannelPermission.VIEW_CHANNEL }
    );
    ctx.pubsub.publishFor(affectedUserIds, ServerEvents.MESSAGE_TYPING, {
      channelId: input.channelId,
      userId: ctx.userId
    });
  });

export { signalTypingRoute };
