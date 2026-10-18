import { AutomodRuleType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
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

const updateAutomodRuleRoute = serverProcedure(Permission.MANAGE_AUTOMOD)
  .input(
    z.object({
      ruleId: z.number().int().positive(),
      name: z.string().min(1).max(100).optional(),
      type: z.nativeEnum(AutomodRuleType).optional(),
      config: automodConfigSchema.optional(),
      actions: automodActionsSchema.optional(),
      exemptRoleIds: automodExemptIdsSchema.optional(),
      exemptChannelIds: automodExemptIdsSchema.optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await assertAutomodRefsInServer(input, ctx.activeServerId);

    const updates: Record<string, unknown> = { updatedAt: Date.now() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.type !== undefined) updates.type = input.type;
    if (input.config !== undefined) updates.config = input.config;
    if (input.actions !== undefined) updates.actions = input.actions;
    if (input.exemptRoleIds !== undefined)
      updates.exemptRoleIds = input.exemptRoleIds;
    if (input.exemptChannelIds !== undefined)
      updates.exemptChannelIds = input.exemptChannelIds;

    const [updated] = await db
      .update(automodRules)
      .set(updates)
      .where(
        and(
          eq(automodRules.id, input.ruleId),
          eq(automodRules.serverId, ctx.activeServerId)
        )
      )
      .returning();

    return updated;
  });

export { updateAutomodRuleRoute };
