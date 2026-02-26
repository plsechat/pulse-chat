import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishEmoji } from '../../db/publishers';
import { emojiExists, getEmojiById } from '../../db/queries/emojis';
import { emojis } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const updateEmojiRoute = protectedProcedure
  .input(
    z.object({
      emojiId: z.number().min(1),
      name: z.string().min(1).max(24)
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_EMOJIS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

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
