import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishCategory } from '../../db/publishers';
import { categories, channels } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const deleteCategoryRoute = protectedProcedure
  .input(
    z.object({
      categoryId: z.number()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CATEGORIES);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const [removedCategory] = await db
      .delete(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.serverId, ctx.activeServerId)))
      .returning();

    invariant(removedCategory, `Category ${input.categoryId} not found`);

    await db
      .delete(channels)
      .where(eq(channels.categoryId, removedCategory.id));

    publishCategory(removedCategory.id, 'delete', removedCategory.serverId);
    enqueueActivityLog({
      type: ActivityLogType.DELETED_CATEGORY,
      userId: ctx.user.id,
      details: {
        categoryId: removedCategory.id,
        categoryName: removedCategory.name
      }
    });
  });

export { deleteCategoryRoute };
