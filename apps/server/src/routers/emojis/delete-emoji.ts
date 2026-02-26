import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { removeFile } from '../../db/mutations/files';
import { publishEmoji } from '../../db/publishers';
import { emojis } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteEmojiRoute = protectedProcedure
  .input(
    z.object({
      emojiId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_EMOJIS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

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
