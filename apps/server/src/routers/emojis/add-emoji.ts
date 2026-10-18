import { ActivityLogType, Permission } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { publishEmoji } from '../../db/publishers';
import { getUniqueEmojiName } from '../../db/queries/emojis';
import { emojis } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { fileManager } from '../../utils/file-manager';
import { serverProcedureFor } from '../../utils/procedures';

const addEmojiRoute = serverProcedureFor(Permission.MANAGE_EMOJIS)
  .input(
    z.object({
      emojis: z
        .array(
          z.object({
            fileId: z.string().max(64),
            name: z.string().min(1).max(32)
          })
        )
        .min(1)
        .max(20)
    })
  )
  .mutation(async ({ input, ctx }) => {
    for (const data of input.emojis) {
      const newFile = await fileManager.saveFile(data.fileId, ctx.userId);
      const uniqueEmojiName = await getUniqueEmojiName(data.name);

      const [emoji] = await db
        .insert(emojis)
        .values({
          name: uniqueEmojiName,
          fileId: newFile.id,
          userId: ctx.userId,
          serverId: input.serverId,
          createdAt: Date.now()
        })
        .returning();

      publishEmoji(emoji!.id, 'create');
      enqueueActivityLog({
        type: ActivityLogType.CREATED_EMOJI,
        userId: ctx.user.id,
        details: {
          name: emoji!.name
        }
      });
    }
  });

export { addEmojiRoute };
