import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishMessage } from '../../db/publishers';
import { getFilesByMessageId } from '../../db/queries/files';
import { getMessageInActiveServer } from '../../db/queries/messages';
import { messages } from '../../db/schema';
import { eventBus } from '../../plugins/event-bus';
import { relayAnnouncementDeletion } from '../../utils/announcement-follow';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

// No server permission up front: authors may delete their own messages;
// everyone else needs MANAGE_MESSAGES (checked once the row is loaded).
const deleteMessageRoute = serverProcedure()
  .input(z.object({ messageId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    const targetMessage = await getMessageInActiveServer(
      input.messageId,
      ctx.activeServerId
    );

    invariant(targetMessage, {
      code: 'NOT_FOUND',
      message: 'Message not found'
    });
    invariant(
      targetMessage.userId === ctx.user.id ||
        (await ctx.hasPermission(Permission.MANAGE_MESSAGES)),
      {
        code: 'FORBIDDEN',
        message: 'You do not have permission to delete this message'
      }
    );

    const files = await getFilesByMessageId(input.messageId);

    if (files.length > 0) {
      const promises = files.map(async (file) => {
        await removeFile(file.id);
      });

      await Promise.all(promises);
    }

    await db.delete(messages).where(eq(messages.id, input.messageId));

    publishMessage(input.messageId, targetMessage.channelId, 'delete');
    void relayAnnouncementDeletion(targetMessage.channelId, [input.messageId]);

    eventBus.emit('message:deleted', {
      channelId: targetMessage.channelId,
      messageId: input.messageId
    });
  });

export { deleteMessageRoute };
