import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishEmoji } from '../../db/publishers';
import { emojis } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const deleteEmojiRoute = serverProcedure(Permission.MANAGE_EMOJIS)
  .input(
    z.object({
      emojiId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [removedEmoji] = await db
      .delete(emojis)
      .where(and(eq(emojis.id, input.emojiId), eq(emojis.serverId, ctx.activeServerId)))
      .returning();

    invariant(removedEmoji, {
      code: 'NOT_FOUND',
      message: 'Emoji not found'
    });

    await removeFile(removedEmoji.fileId);

    publishEmoji(removedEmoji.id, 'delete', removedEmoji.serverId);
    enqueueActivityLog({
      type: ActivityLogType.DELETED_EMOJI,
      userId: ctx.user.id,
      details: {
        name: removedEmoji.name
      }
    });
  });

export { deleteEmojiRoute };
