import { ServerEvents } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { getDmChannelMemberIds } from '../../db/queries/dms';
import { dmMessageFiles, dmMessages } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { pubsub } from '../../utils/pubsub';
import { protectedProcedure } from '../../utils/trpc';

const deleteMessageRoute = protectedProcedure
  .input(z.object({ messageId: z.number() }))
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

    const memberIds = await getDmChannelMemberIds(msg.dmChannelId);

    // Clean up attached files before deleting the message
    const attachedFiles = await db
      .select({ fileId: dmMessageFiles.fileId })
      .from(dmMessageFiles)
      .where(eq(dmMessageFiles.dmMessageId, input.messageId));

    for (const { fileId } of attachedFiles) {
      await removeFile(fileId);
    }

    await db.delete(dmMessages).where(eq(dmMessages.id, input.messageId));

    for (const memberId of memberIds) {
      pubsub.publishFor(memberId, ServerEvents.DM_MESSAGE_DELETE, {
        dmMessageId: input.messageId,
        dmChannelId: msg.dmChannelId
      });
    }
  });

export { deleteMessageRoute };
