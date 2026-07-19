import { ActivityLogType, OWNER_ROLE_ID, Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { roles, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';
import { enqueueActivityLog } from '../../queues/activity-log';

const addRoleRoute = protectedProcedure
  .input(
    z.object({
      userId: z.number(),
      roleId: z.number()
    })
  )
  .mutation(async ({ ctx, input }) => {
    await ctx.needsPermission(Permission.MANAGE_USERS);

    invariant(ctx.activeServerId, {
      code: 'BAD_REQUEST',
      message: 'No active server'
    });

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
        isDefault: roles.isDefault
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
