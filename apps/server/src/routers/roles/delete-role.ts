import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { fallbackUsersToDefaultRole } from '../../db/mutations/users';
import { publishRole } from '../../db/publishers';
import { getRole } from '../../db/queries/roles';
import { roles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { assertCanManageRole, getRoleCeiling } from './_hierarchy';
import { invalidateAllPermissionCaches } from '../../utils/permission-cache-registry';

const deleteRoleRoute = serverProcedure(Permission.MANAGE_ROLES)
  .input(
    z.object({
      roleId: z.number().int().positive()
    })
  )
  .mutation(async ({ input, ctx }) => {
    const role = await getRole(input.roleId);

    invariant(role, {
      code: 'NOT_FOUND',
      message: 'Role not found'
    });

    invariant(role.serverId === ctx.activeServerId, {
      code: 'NOT_FOUND',
      message: 'Role not found in this server'
    });
    invariant(!role.isPersistent, {
      code: 'FORBIDDEN',
      message: 'Cannot delete a persistent role'
    });
    invariant(!role.isDefault, {
      code: 'FORBIDDEN',
      message: 'Cannot delete the default role'
    });

    const ceiling = await getRoleCeiling(ctx.userId, ctx.activeServerId);
    assertCanManageRole(ceiling, role);

    await fallbackUsersToDefaultRole(role.id, role.serverId);
    await db.delete(roles).where(eq(roles.id, role.id));

    invalidateAllPermissionCaches();
    publishRole(role.id, 'delete', role.serverId);
    enqueueActivityLog({
      type: ActivityLogType.DELETED_ROLE,
      userId: ctx.user.id,
      details: {
        roleId: role.id,
        roleName: role.name
      }
    });
  });

export { deleteRoleRoute };
