import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { tombstoneDmMessage } from '../../db/mutations/messages';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmMessages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const deleteMessageRoute = protectedProcedure
  .input(z.object({ messageId: z.number().int().positive() }))
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
      message: 'You can only delete your own messages'
    });

    invariant(!msg.deletedAt, {
      code: 'BAD_REQUEST',
      message: 'Message is already deleted'
    });

    const memberIds = await getDmChannelMemberIds(msg.dmChannelId);

    // The row stays as a tombstone; attachments, reactions and the
    // content — ciphertext included — go now (db/mutations/messages.ts).
    const deletedAt = Date.now();
    await tombstoneDmMessage(input.messageId, ctx.userId, deletedAt);

    for (const memberId of memberIds) {
      pubsub.publishFor(memberId, ServerEvents.DM_MESSAGE_DELETE, {
        dmMessageId: input.messageId,
        dmChannelId: msg.dmChannelId,
        deletedAt,
        deletedBy: ctx.userId
      });
    }
  });

export { deleteMessageRoute };
