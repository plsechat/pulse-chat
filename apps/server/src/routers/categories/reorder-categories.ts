import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishCategory } from '../../db/publishers';
import { categories } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const reorderCategoriesRoute = serverProcedure(Permission.MANAGE_CATEGORIES)
  .input(
    z.object({
      categoryIds: z.array(z.number().int().positive()).max(200)
    })
  )
  .mutation(async ({ input, ctx }) => {
    invariant(new Set(input.categoryIds).size === input.categoryIds.length, {
      code: 'BAD_REQUEST',
      message: 'categoryIds contains duplicates'
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
