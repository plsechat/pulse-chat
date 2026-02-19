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
      content: z.string().max(4000).optional(),
      encryptedContent: z.string().max(16000).optional()
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

    const updateSet: Record<string, unknown> = {
      edited: true,
      updatedAt: Date.now()
    };

    if (msg.e2ee) {
      invariant(input.encryptedContent, {
        code: 'BAD_REQUEST',
        message: 'E2EE messages must be edited with encryptedContent'
      });
      updateSet.encryptedContent = input.encryptedContent;
    } else {
      invariant(input.content, {
        code: 'BAD_REQUEST',
        message: 'Non-E2EE messages must be edited with content'
      });
      updateSet.content = input.content;
    }

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
