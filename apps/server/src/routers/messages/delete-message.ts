import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishMessage } from '../../db/publishers';
import { getFilesByMessageId } from '../../db/queries/files';
import { channels, messages } from '../../db/schema';
import { eventBus } from '../../plugins/event-bus';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteMessageRoute = protectedProcedure
  .input(z.object({ messageId: z.number() }))
  .mutation(async ({ input, ctx }) => {
    // Join channels so the message is scoped to the caller's active server.
    // Without this, an author with MANAGE_MESSAGES in any server could
    // delete any message globally; even regular authors could delete their
    // own messages in channels they no longer have access to.
    const [targetMessage] = await db
      .select({
        userId: messages.userId,
        channelId: messages.channelId
      })
      .from(messages)
      .innerJoin(channels, eq(channels.id, messages.channelId))
      .where(
        and(
          eq(messages.id, input.messageId),
          eq(channels.serverId, ctx.activeServerId!)
        )
      )
      .limit(1);

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

    eventBus.emit('message:deleted', {
      channelId: targetMessage.channelId,
      messageId: input.messageId
    });
  });

export { deleteMessageRoute };
