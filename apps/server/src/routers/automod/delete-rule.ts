import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { automodRules } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';

const deleteAutomodRuleRoute = serverProcedure(Permission.MANAGE_AUTOMOD)
  .input(z.object({ ruleId: z.number().int().positive() }))
  .mutation(async ({ input, ctx }) => {
    await db
      .delete(automodRules)
      .where(
        and(
          eq(automodRules.id, input.ruleId),
          eq(automodRules.serverId, ctx.activeServerId)
        )
      );
  });

export { deleteAutomodRuleRoute };
