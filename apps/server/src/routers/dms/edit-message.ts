import { MAX_MESSAGE_WIRE_LENGTH, ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { getDmChannelMemberIds, getDmMessage } from '../../db/queries/dms';
import { dmMessages } from '../../db/schema';
import { enqueueProcessDmMetadata } from '../../queues/dm-message-metadata';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const editMessageRoute = protectedProcedure
  .input(
    z.object({
      messageId: z.number().int().positive(),
      content: z
        .string()
        .min(1, 'Edited messages must include content')
        .max(MAX_MESSAGE_WIRE_LENGTH, 'Message is too long'),
      /**
       * Whether `content` is a ciphertext envelope. Required so the
       * server can refuse plaintext over an encrypted row (and vice
       * versa) — the send route enforces the same contract.
       */
      e2ee: z.boolean()
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

    invariant(msg.e2ee === input.e2ee, {
      code: 'BAD_REQUEST',
      message: msg.e2ee
        ? 'This message is encrypted — plaintext edits are not allowed.'
        : 'This message is not encrypted — encrypted edits are not allowed.'
    });

    await db
      .update(dmMessages)
      .set({
        content: input.content,
        edited: true,
        updatedAt: Date.now()
      })
      .where(eq(dmMessages.id, input.messageId));

    const joined = await getDmMessage(input.messageId);
    const memberIds = await getDmChannelMemberIds(msg.dmChannelId);

    if (joined) {
      for (const memberId of memberIds) {
        pubsub.publishFor(memberId, ServerEvents.DM_MESSAGE_UPDATE, joined);
      }
    }

    // Link previews follow the edited text; ciphertext has nothing to
    // extract (the send route skips it the same way).
    if (!msg.e2ee) {
      enqueueProcessDmMetadata(input.content, input.messageId, msg.dmChannelId);
    }
  });

export { editMessageRoute };
