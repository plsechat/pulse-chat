import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { categories } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';

const getCategoryRoute = serverProcedure(Permission.MANAGE_CATEGORIES)
  .input(
    z.object({
      categoryId: z.number().int().positive()
    })
  )
  .query(async ({ input, ctx }) => {
    // Scope to the caller's active server so MANAGE_CATEGORIES in server A
    // can't read categories belonging to server B.
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

    return category;
  });

export { getCategoryRoute };
