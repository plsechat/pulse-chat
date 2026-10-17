import { ActivityLogType, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { rotateFileAccessTokens } from '../../db/mutations/channels';
import { publishUser } from '../../db/publishers';
import { roles, userRoles } from '../../db/schema';
import { emitMemberRolesChanged } from '../../plugins/emit-roles-changed';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { enqueueActivityLog } from '../../queues/activity-log';
import { assertCanManageRole, getRoleCeiling } from '../roles/_hierarchy';
import { invalidatePermissionCacheForUser } from '../../utils/permission-cache-registry';

const removeRoleRoute = serverProcedure(Permission.MANAGE_USERS)
  .input(
    z.object({
      userId: z.number().int().positive(),
      roleId: z.number().int().positive()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // Verify the role belongs to the caller's active server
    const [role] = await db
      .select({
        id: roles.id,
        name: roles.name,
        isPersistent: roles.isPersistent,
        isDefault: roles.isDefault,
        position: roles.position
      })
      .from(roles)
      .where(
        and(eq(roles.id, input.roleId), eq(roles.serverId, ctx.activeServerId))
      )
      .limit(1);

    invariant(role, {
      code: 'NOT_FOUND',
      message: 'Role not found'
    });

    // The owner role (every server seeds one: persistent + non-default,
    // all permissions) can never be removed here — ownership moves ONLY
    // through servers.transferOwner. Gating on the capability flags, not
    // a role id: OWNER_ROLE_ID === 1 is just the bootstrap server's row,
    // so an id check alone leaves every other server's owner role
    // assignable by any MANAGE_USERS holder (full-permission escalation).
    invariant(!(role.isPersistent && !role.isDefault), {
      code: 'FORBIDDEN',
      message: 'The Owner role can only change via ownership transfer'
    });

    // Role hierarchy: a caller may only strip roles strictly below their
    // own highest role.
    const ceiling = await getRoleCeiling(ctx.userId, ctx.activeServerId);
    assertCanManageRole(ceiling, role);

    const existing = await db
      .select()
      .from(userRoles)
      .where(
        and(
          eq(userRoles.userId, input.userId),
          eq(userRoles.roleId, input.roleId)
        )
      )
      .limit(1);

    invariant(existing.length > 0, {
      code: 'NOT_FOUND',
      message: 'User does not have this role'
    });

    await db
      .delete(userRoles)
      .where(
        and(
          eq(userRoles.userId, input.userId),
          eq(userRoles.roleId, input.roleId)
        )
      );

    ctx.invalidatePermissionCache();
    invalidatePermissionCacheForUser(input.userId);
    // The role may have been what let them see a private channel:
    // re-key every private channel's attachment URLs in this server.
    await rotateFileAccessTokens({ serverId: ctx.activeServerId });
    publishUser(input.userId, 'update');
    await emitMemberRolesChanged(input.userId, ctx.activeServerId);

    enqueueActivityLog({
      type: ActivityLogType.USER_ROLE_REMOVED,
      userId: input.userId,
      serverId: ctx.activeServerId,
      details: {
        roleId: input.roleId,
        roleName: role.name,
        removedBy: ctx.userId
      }
    });
  });

export { removeRoleRoute };
