import { ActivityLogType, OWNER_ROLE_ID, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { isServerMember } from '../../db/queries/servers';
import { roles, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { serverProcedure } from '../../utils/procedures';
import { enqueueActivityLog } from '../../queues/activity-log';
import { assertCanManageRole, getRoleCeiling } from '../roles/_hierarchy';
import { invalidatePermissionCacheForUser } from '../../utils/permission-cache-registry';

const addRoleRoute = serverProcedure(Permission.MANAGE_USERS)
  .input(
    z.object({
      userId: z.number().int().positive(),
      roleId: z.number().int().positive()
    })
  )
  .mutation(async ({ ctx, input }) => {
    // The Owner role can only be acquired through ownership transfer, never
    // granted via add-role — even by callers with MANAGE_USERS. The active-
    // server scope on the role lookup below is necessary but not sufficient
    // because OWNER_ROLE_ID = 1 is the bootstrap server's owner role and
    // would pass the scope check there.
    invariant(input.roleId !== OWNER_ROLE_ID, {
      code: 'FORBIDDEN',
      message: 'The Owner role cannot be granted via add-role'
    });

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
    // all permissions) can never be granted here — ownership moves ONLY
    // through servers.transferOwner. Gating on the capability flags, not
    // a role id: OWNER_ROLE_ID === 1 is just the bootstrap server's row,
    // so an id check alone leaves every other server's owner role
    // assignable by any MANAGE_USERS holder (full-permission escalation).
    invariant(!(role.isPersistent && !role.isDefault), {
      code: 'FORBIDDEN',
      message: 'The Owner role can only change via ownership transfer'
    });

    // Role hierarchy: only roles strictly below the caller's own highest
    // role may be handed out — this is what stops a MANAGE_USERS holder
    // from giving themselves (or anyone) a more senior role.
    const ceiling = await getRoleCeiling(ctx.userId, ctx.activeServerId);
    assertCanManageRole(ceiling, role);

    invariant(await isServerMember(ctx.activeServerId, input.userId), {
      code: 'NOT_FOUND',
      message: 'User not found'
    });

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

    invariant(existing.length === 0, {
      code: 'CONFLICT',
      message: 'User already has this role'
    });

    await db.insert(userRoles).values({
      userId: input.userId,
      roleId: input.roleId,
      createdAt: Date.now()
    });

    ctx.invalidatePermissionCache();
    invalidatePermissionCacheForUser(input.userId);
    publishUser(input.userId, 'update');

    enqueueActivityLog({
      type: ActivityLogType.USER_ROLE_ASSIGNED,
      userId: input.userId,
      serverId: ctx.activeServerId,
      details: {
        roleId: input.roleId,
        roleName: role.name,
        assignedBy: ctx.userId
      }
    });
  });

export { addRoleRoute };
