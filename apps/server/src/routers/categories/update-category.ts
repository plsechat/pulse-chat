import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishCategory } from '../../db/publishers';
import { categories } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const updateCategoryRoute = protectedProcedure
  .input(
    z.object({
      categoryId: z.number().min(1),
      name: z.string().min(1).max(24)
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_CATEGORIES);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const [existingCategory] = await db
      .select()
      .from(categories)
      .where(and(eq(categories.id, input.categoryId), eq(categories.serverId, ctx.activeServerId)))
      .limit(1);

    invariant(existingCategory, {
      code: 'NOT_FOUND',
      message: 'Category not found.'
    });

    await db
      .update(categories)
      .set({
        name: input.name,
        updatedAt: Date.now()
      })
      .where(eq(categories.id, input.categoryId));

    publishCategory(input.categoryId, 'update');
    enqueueActivityLog({
      type: ActivityLogType.UPDATED_CATEGORY,
      userId: ctx.user.id,
      details: {
        categoryId: input.categoryId,
        values: {
          name: input.name
        }
      }
    });
  });

export { updateCategoryRoute };
