import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishRole } from '../../db/publishers';
import { getDefaultRole, getRole } from '../../db/queries/roles';
import { roles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const setDefaultRoleRoute = protectedProcedure
  .input(
    z.object({
      roleId: z.number().min(1)
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_ROLES);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

    const defaultRole = await getDefaultRole();

    invariant(defaultRole, {
      code: 'NOT_FOUND',
      message: 'Default role not found'
    });

    if (input.roleId === defaultRole?.id) return;

    const newDefaultRole = await getRole(input.roleId);

    invariant(newDefaultRole, {
      code: 'NOT_FOUND',
      message: 'Role not found'
    });

    // Ensure the role belongs to the caller's active server
    invariant(newDefaultRole.serverId === ctx.activeServerId, {
      code: 'NOT_FOUND',
      message: 'Role not found in this server'
    });

    await db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({ isDefault: false })
        .where(eq(roles.id, defaultRole.id));

      await tx
        .update(roles)
        .set({ isDefault: true })
        .where(eq(roles.id, input.roleId));
    });

    await Promise.all([
      publishRole(defaultRole.id, 'update'),
      publishRole(input.roleId, 'update')
    ]);

    enqueueActivityLog({
      type: ActivityLogType.UPDATED_DEFAULT_ROLE,
      userId: ctx.user.id,
      details: {
        newRoleId: input.roleId,
        oldRoleId: defaultRole.id,
        newRoleName: newDefaultRole.name,
        oldRoleName: defaultRole.name
      }
    });
  });

export { setDefaultRoleRoute };
