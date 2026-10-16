import { AutomodRuleType, Permission } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { automodRules } from '../../db/schema';
import { serverProcedure } from '../../utils/procedures';
import {
  assertAutomodRefsInServer,
  automodActionsSchema,
  automodConfigSchema,
  automodExemptIdsSchema
} from './_shared';

const createAutomodRuleRoute = serverProcedure(Permission.MANAGE_AUTOMOD)
  .input(
    z.object({
      name: z.string().min(1).max(100),
      type: z.nativeEnum(AutomodRuleType),
      config: automodConfigSchema,
      actions: automodActionsSchema,
      exemptRoleIds: automodExemptIdsSchema.optional(),
      exemptChannelIds: automodExemptIdsSchema.optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await assertAutomodRefsInServer(input, ctx.activeServerId);

    const [rule] = await db
      .insert(automodRules)
      .values({
        name: input.name,
        type: input.type,
        config: input.config,
        actions: input.actions,
        exemptRoleIds: input.exemptRoleIds ?? [],
        exemptChannelIds: input.exemptChannelIds ?? [],
        serverId: ctx.activeServerId,
        createdBy: ctx.userId,
        createdAt: Date.now()
      })
      .returning();

    return rule;
  });

export { createAutomodRuleRoute };
