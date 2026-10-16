import { ServerEvents } from '@pulse/shared';
import { z } from 'zod';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const signalDmTypingRoute = protectedProcedure
  .input(
    z.object({
      dmChannelId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const memberIds = await getDmChannelMemberIds(input.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    const otherMemberIds = memberIds.filter((id) => id !== ctx.userId);

    ctx.pubsub.publishFor(otherMemberIds, ServerEvents.DM_MESSAGE_TYPING, {
      dmChannelId: input.dmChannelId,
      userId: ctx.userId
    });
  });

export { signalDmTypingRoute };
