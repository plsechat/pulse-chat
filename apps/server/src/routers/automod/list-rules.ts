import { Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { automodRules } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';

const listAutomodRulesRoute = serverProcedure(Permission.MANAGE_AUTOMOD).query(
  async ({ ctx }) =>
    db
      .select()
      .from(automodRules)
      .where(eq(automodRules.serverId, ctx.activeServerId))
);

export { listAutomodRulesRoute };
