import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { dmMessages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const pinDmMessageRoute = protectedProcedure
  .input(
    z.object({
      dmMessageId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [message] = await db
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.id, input.dmMessageId))
      .limit(1);

    invariant(message, {
      code: 'NOT_FOUND',
      message: `DM message ${input.dmMessageId} not found`
    });

    const memberIds = await getDmChannelMemberIds(message.dmChannelId);

    invariant(memberIds.includes(ctx.userId), {
      code: 'FORBIDDEN',
      message: 'You are not a member of this DM channel'
    });

    invariant(!message.pinned, {
      code: 'BAD_REQUEST',
      message: 'Message is already pinned'
    });

    await db
      .update(dmMessages)
      .set({
        pinned: true,
        pinnedAt: Date.now(),
        pinnedBy: ctx.userId
      })
      .where(eq(dmMessages.id, input.dmMessageId));

    const updated = await getDmMessage(input.dmMessageId);

    if (updated) {
      for (const memberId of memberIds) {
        ctx.pubsub.publishFor(
          memberId,
          ServerEvents.DM_MESSAGE_UPDATE,
          updated
        );
      }
    }
  });

export { pinDmMessageRoute };
