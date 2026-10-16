import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishCategory, publishChannel } from '../../db/publishers';
import { categories, channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { VoiceRuntime } from '../../runtimes/voice';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const deleteCategoryRoute = serverProcedure(Permission.MANAGE_CATEGORIES)
  .input(
    z.object({
      categoryId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const [category] = await db
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.id, input.categoryId),
          eq(categories.serverId, ctx.activeServerId)
        )
      )
      .limit(1);

    invariant(category, {
      code: 'NOT_FOUND',
      message: 'Category not found'
    });

    // The category's channels go with it: tear down their voice runtimes
    // (a router left alive after its channel row is gone lives forever)
    // and tell clients about each channel, not just the category.
    const removedChannels = await db
      .delete(channels)
      .where(eq(channels.categoryId, category.id))
      .returning({ id: channels.id });

    for (const channel of removedChannels) {
      const runtime = VoiceRuntime.findById(channel.id);
      if (runtime) await runtime.destroy();
    }

    await db.delete(categories).where(eq(categories.id, category.id));

    for (const channel of removedChannels) {
      publishChannel(channel.id, 'delete', category.serverId);
    }
    publishCategory(category.id, 'delete', category.serverId);

    enqueueActivityLog({
      type: ActivityLogType.DELETED_CATEGORY,
      userId: ctx.user.id,
      details: {
        categoryId: category.id,
        categoryName: category.name
      }
    });
  });

export { deleteCategoryRoute };
