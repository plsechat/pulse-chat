import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishChannel } from '../../db/publishers';
import { categories, channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const reorderChannelsRoute = protectedProcedure
  .input(
    z.object({
      categoryId: z.number(),
      channelIds: z.array(z.number())
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CHANNELS);

    // Verify the category belongs to the caller's active server
    const [category] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.id, input.categoryId),
          eq(categories.serverId, ctx.activeServerId!)
        )
      )
      .limit(1);

    invariant(category, {
      code: 'NOT_FOUND',
      message: 'Category not found'
    });

    await db.transaction(async (tx) => {
      for (let i = 0; i < input.channelIds.length; i++) {
        const channelId = input.channelIds[i]!;
        const newPosition = i + 1;

        // Only update channels that belong to the active server
        await tx
          .update(channels)
          .set({
            position: newPosition,
            updatedAt: Date.now()
          })
          .where(
            and(
              eq(channels.id, channelId),
              eq(channels.serverId, ctx.activeServerId!)
            )
          );
      }
    });

    input.channelIds.forEach((channelId) => {
      publishChannel(channelId, 'update');
    });

    if (input.channelIds.length > 0) {
      enqueueActivityLog({
        type: ActivityLogType.UPDATED_CHANNEL,
        userId: ctx.user.id,
        details: {
          channelId: input.channelIds[0]!,
          values: {
            position: input.channelIds.length
          }
        }
      });
    }
  });

export { reorderChannelsRoute };
