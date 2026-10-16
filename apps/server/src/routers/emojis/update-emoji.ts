import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishEmoji } from '../../db/publishers';
import { emojiExists, getEmojiById } from '../../db/queries/emojis';
import { emojis } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const updateEmojiRoute = serverProcedure(Permission.MANAGE_EMOJIS)
  .input(
    z.object({
      emojiId: z.number().int().positive(),
      name: z.string().min(1).max(32)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const existingEmoji = await getEmojiById(input.emojiId);

    invariant(existingEmoji, {
      code: 'NOT_FOUND',
      message: 'Emoji not found'
    });

    invariant(existingEmoji.serverId === ctx.activeServerId, {
      code: 'NOT_FOUND',
      message: 'Emoji not found in this server'
    });

    const exists = await emojiExists(input.name);

    if (exists) {
      ctx.throwValidationError(
        'name',
        'An emoji with this name already exists.'
      );
    }

    const [updatedEmoji] = await db
      .update(emojis)
      .set({
        name: input.name,
        updatedAt: Date.now()
      })
      .where(eq(emojis.id, existingEmoji.id))
      .returning();

    publishEmoji(updatedEmoji!.id, 'update');
    enqueueActivityLog({
      type: ActivityLogType.UPDATED_EMOJI,
      userId: ctx.user.id,
      details: {
        fromName: existingEmoji.name,
        toName: input.name
      }
    });
  });

export { updateEmojiRoute };
