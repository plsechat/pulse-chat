import type { Permission } from '@pulse/shared';
import type { TJoinedRole } from '../../types';
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { rolePermissions, roles, userRoles } from '../../db/schema';

const getUserRoles = async (
  userId: number,
  serverId?: number
): Promise<TJoinedRole[]> => {
  const conditions = [eq(userRoles.userId, userId)];

  if (serverId !== undefined) {
    conditions.push(eq(roles.serverId, serverId));
  }

  const result = await db
    .select({
      role: roles,
      permission: rolePermissions.permission
    })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .leftJoin(rolePermissions, eq(roles.id, rolePermissions.roleId))
    .where(and(...conditions));

  if (result.length === 0) return [];

  const rolesMap = new Map<number, TJoinedRole>();

  for (const row of result) {
    const roleId = row.role.id;

    if (!rolesMap.has(roleId)) {
      rolesMap.set(roleId, {
        ...row.role,
        permissions: []
      });
    }

    if (row.permission) {
      rolesMap.get(roleId)!.permissions.push(row.permission as Permission);
    }
  }

  return Array.from(rolesMap.values());
};

export { getUserRoles };
