import { Permission } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import { publishUser } from '../../db/publishers';
import { roles, userRoles } from '../../db/schema';
import { invariant } from '../../utils/invariant';
import { protectedProcedure } from '../../utils/trpc';

const removeRoleRoute = protectedProcedure
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

    // Verify the role belongs to the caller's active server
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(eq(roles.id, input.roleId), eq(roles.serverId, ctx.activeServerId))
      )
      .limit(1);

    invariant(role, {
      code: 'NOT_FOUND',
      message: 'Role not found'
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
    publishUser(input.userId, 'update');
  });

export { removeRoleRoute };
