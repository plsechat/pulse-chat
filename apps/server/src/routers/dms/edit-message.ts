import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { dmMessages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const editMessageRoute = protectedProcedure
  .input(
    z.object({
      messageId: z.number(),
      content: z.string().max(4000)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const [msg] = await db
      .select()
      .from(dmMessages)
      .where(eq(dmMessages.id, input.messageId))
      .limit(1);

    invariant(msg, {
      code: 'NOT_FOUND',
      message: 'Message not found'
    });

    invariant(msg.userId === ctx.userId, {
      code: 'FORBIDDEN',
      message: 'You can only edit your own messages'
    });

    await db
      .update(dmMessages)
      .set({ content: input.content, edited: true, updatedAt: Date.now() })
      .where(eq(dmMessages.id, input.messageId));

    const joined = await getDmMessage(input.messageId);
    const memberIds = await getDmChannelMemberIds(msg.dmChannelId);

    if (joined) {
      for (const memberId of memberIds) {
        pubsub.publishFor(memberId, ServerEvents.DM_MESSAGE_UPDATE, joined);
      }
    }
  });

export { editMessageRoute };
