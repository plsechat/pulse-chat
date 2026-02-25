import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishCategory } from '../../db/publishers';
import { categories } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const reorderCategoriesRoute = protectedProcedure
  .input(
    z.object({
      categoryIds: z.array(z.number())
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CATEGORIES);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const serverId = ctx.activeServerId;

    await db.transaction(async (tx) => {
      for (let i = 0; i < input.categoryIds.length; i++) {
        const categoryId = input.categoryIds[i]!;
        const newPosition = i + 1;

        await tx
          .update(categories)
          .set({
            position: newPosition,
            updatedAt: Date.now()
          })
          .where(and(eq(categories.id, categoryId), eq(categories.serverId, serverId)));
      }
    });

    input.categoryIds.forEach((categoryId) => {
      publishCategory(categoryId, 'update');
    });

    if (input.categoryIds.length > 0) {
      enqueueActivityLog({
        type: ActivityLogType.UPDATED_CATEGORY,
        userId: ctx.user.id,
        details: {
          categoryId: input.categoryIds[0]!,
          values: {
            position: input.categoryIds.length
          }
        }
      });
    }
  });

export { reorderCategoriesRoute };
