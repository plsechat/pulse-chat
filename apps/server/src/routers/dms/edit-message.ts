import { MAX_MESSAGE_WIRE_LENGTH, ServerEvents } from '@pulse/shared';
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
      content: z
        .string()
        .max(MAX_MESSAGE_WIRE_LENGTH, 'Message is too long')
        .optional()
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

    // A forwarded message is a verbatim copy of another author's
    // message; it can never be edited (same rule as channel forwards,
    // which use the `editable` flag they don't have here).
    invariant(!msg.forwardedFromUserId, {
      code: 'FORBIDDEN',
      message: 'Forwarded messages cannot be edited'
    });

    const updateSet: Record<string, unknown> = {
      edited: true,
      updatedAt: Date.now()
    };

    invariant(input.content, {
      code: 'BAD_REQUEST',
      message: 'Edited messages must include content'
    });
    updateSet.content = input.content;

    await db
      .update(dmMessages)
      .set(updateSet)
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
