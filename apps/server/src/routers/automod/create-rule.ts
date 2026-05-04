import { AutomodRuleType, Permission } from '@pulse/shared';
import { z } from 'zod';
import { db } from '../../db';
import { automodRules } from '../../db/schema';
import { protectedProcedure } from '../../utils/trpc';
import { automodActionsSchema, automodConfigSchema } from './_shared';

const createAutomodRuleRoute = protectedProcedure
  .input(
    z.object({
      name: z.string().min(1).max(100),
      type: z.nativeEnum(AutomodRuleType),
      config: automodConfigSchema,
      actions: automodActionsSchema,
      exemptRoleIds: z.array(z.number()).optional(),
      exemptChannelIds: z.array(z.number()).optional()
    })
  )
  .mutation(async ({ input, ctx }) => {
    await ctx.needsPermission(Permission.MANAGE_AUTOMOD);

    const [rule] = await db
      .insert(automodRules)
      .values({
        name: input.name,
        type: input.type,
        config: input.config,
        actions: input.actions,
        exemptRoleIds: input.exemptRoleIds ?? [],
        exemptChannelIds: input.exemptChannelIds ?? [],
        serverId: ctx.activeServerId!,
        createdBy: ctx.userId,
        createdAt: Date.now()
      })
      .returning();

    return rule;
  });

export { createAutomodRuleRoute };
