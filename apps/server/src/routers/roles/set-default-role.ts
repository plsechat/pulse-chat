import { ActivityLogType, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { rotateFileAccessTokens } from '../../db/mutations/channels';
import { publishRole } from '../../db/publishers';
import { getDefaultRoleForServer, getRole } from '../../db/queries/roles';
import { roles } from '../../db/schema';
import { enqueueActivityLog } from '../../queues/activity-log';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { getRoleCeiling } from './_hierarchy';
import { invalidateAllPermissionCaches } from '../../utils/permission-cache-registry';

const setDefaultRoleRoute = serverProcedure(Permission.MANAGE_ROLES)
  .input(
    z.object({
      roleId: z.number().int().positive()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // The ACTIVE server's default role — never an instance-wide lookup,
    // which on a multi-server instance flipped another server's default.
    const defaultRole = await getDefaultRoleForServer(ctx.activeServerId);

    invariant(defaultRole, {
      code: 'NOT_FOUND',
      message: 'Default role not found'
    });

    if (input.roleId === defaultRole.id) return;

    const newDefaultRole = await getRole(input.roleId);

    invariant(newDefaultRole && newDefaultRole.serverId === ctx.activeServerId, {
      code: 'NOT_FOUND',
      message: 'Role not found in this server'
    });

    // Everyone who joins gets the default role, so making the owner role
    // the default would hand every member owner permissions.
    invariant(!(newDefaultRole.isPersistent && !newDefaultRole.isDefault), {
      code: 'FORBIDDEN',
      message: 'The owner role cannot be the default role'
    });

    const ceiling = await getRoleCeiling(ctx.userId, ctx.activeServerId);
    invariant(ceiling.owner || newDefaultRole.position <= ceiling.top, {
      code: 'FORBIDDEN',
      message: 'You can only make a role at or below your highest role the default'
    });

    await db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({ isDefault: false })
        .where(eq(roles.id, defaultRole.id));

      await tx
        .update(roles)
        .set({ isDefault: true })
        .where(eq(roles.id, newDefaultRole.id));
    });

    // Every member holds the default role: swapping it can take a
    // private channel away from all of them at once, so re-key every
    // private channel's attachment URLs in this server.
    await rotateFileAccessTokens({ serverId: ctx.activeServerId });

    await Promise.all([
      invalidateAllPermissionCaches(),
      publishRole(defaultRole.id, 'update'),
      publishRole(newDefaultRole.id, 'update')
    ]);

    enqueueActivityLog({
      type: ActivityLogType.UPDATED_DEFAULT_ROLE,
      userId: ctx.user.id,
      details: {
        newRoleId: newDefaultRole.id,
        oldRoleId: defaultRole.id,
        newRoleName: newDefaultRole.name,
        oldRoleName: defaultRole.name
      }
    });
  });

export { setDefaultRoleRoute };
