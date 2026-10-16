import { ActivityLogType, OWNER_ROLE_ID, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { syncRolePermissions } from '../../db/mutations/roles';
import { publishRole } from '../../db/publishers';
import { getRole } from '../../db/queries/roles';
import { roles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { invalidateAllPermissionCaches } from '../../utils/permission-cache-registry';
import {
  assertCanManageRole,
  assertPermissionsWithinCeiling,
  getRoleCeiling
} from './_hierarchy';

const updateRoleRoute = serverProcedure(Permission.MANAGE_ROLES)
  .input(
    z.object({
      roleId: z.number().int().positive(),
      name: z.string().min(1).max(24),
      color: z
        .string()
        .regex(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, 'Invalid hex color'),
      permissions: z.enum(Permission).array().max(64)
    })
  )
  .mutation(async ({ ctx, input }) => {
    const role = await getRole(input.roleId);

    invariant(role && role.serverId === ctx.activeServerId, {
      code: 'NOT_FOUND',
      message: 'Role not found in this server'
    });

    const ceiling = await getRoleCeiling(ctx.userId, ctx.activeServerId);
    assertCanManageRole(ceiling, role);
    assertPermissionsWithinCeiling(ceiling, input.permissions);

    const [updatedRole] = await db
      .update(roles)
      .set({
        name: input.name,
        color: input.color,
        updatedAt: Date.now()
      })
      .where(eq(roles.id, role.id))
      .returning();

    invariant(updatedRole, {
      code: 'NOT_FOUND',
      message: 'Role not found in this server'
    });

    // The owner role's permission set is immutable: it is the all-
    // permissions role by definition (OWNER_ROLE_ID is the bootstrap
    // server's row; every other server's owner role is persistent +
    // non-default).
    const isOwnerRole =
      role.id === OWNER_ROLE_ID || (role.isPersistent && !role.isDefault);

    if (!isOwnerRole) {
      await syncRolePermissions(updatedRole.id, input.permissions);
    }

    invalidateAllPermissionCaches();
    publishRole(updatedRole.id, 'update');
    enqueueActivityLog({
      type: ActivityLogType.UPDATED_ROLE,
      userId: ctx.user.id,
      details: {
        roleId: updatedRole.id,
        permissions: input.permissions,
        values: input
      }
    });
  });

export { updateRoleRoute };
