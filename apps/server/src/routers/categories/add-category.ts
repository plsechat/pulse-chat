import { ActivityLogType, Permission } from '@pulse/shared';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishCategory } from '../../db/publishers';
import { categories } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { protectedProcedure } from '../../utils/trpc';

const addCategoryRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1).max(32),
      serverId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_CATEGORIES, input.serverId);

    const [result] = await db
      .select({ maxPos: sql<number>`COALESCE(MAX(${categories.position}), 0)` })
      .from(categories)
      .where(eq(categories.serverId, input.serverId));

    const targetPosition = (result?.maxPos ?? 0) + 1;

    const [created] = await db
      .insert(categories)
      .values({
        name: input.name,
        position: targetPosition,
        serverId: input.serverId,
        createdAt: Date.now()
      })
      .returning();

    publishCategory(created!.id, 'create');
    enqueueActivityLog({
      type: ActivityLogType.CREATED_CATEGORY,
      userId: ctx.user.id,
      details: {
        categoryName: input.name,
        categoryId: created!.id
      }
    });

    return created!.id;
  });

export { addCategoryRoute };
