import { AutomodRuleType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { automodRules } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';
import { automodActionsSchema, automodConfigSchema } from './_shared';

const updateAutomodRuleRoute = protectedProcedure
  .input(
    z.object({
      ruleId: z.number(),
      name: z.string().min(1).max(100).optional(),
      type: z.nativeEnum(AutomodRuleType).optional(),
      config: automodConfigSchema.optional(),
      actions: automodActionsSchema.optional(),
      exemptRoleIds: z.array(z.number()).optional(),
      exemptChannelIds: z.array(z.number()).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_AUTOMOD);

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
          eq(automodRules.serverId, ctx.activeServerId!)
        )
      )
      .returning();

    return updated;
  });

export { updateAutomodRuleRoute };
