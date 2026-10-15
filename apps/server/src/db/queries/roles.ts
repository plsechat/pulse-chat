import type { Permission, TJoinedRole, TRole } from '@pulse/shared';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { db } from '..';
import { rolePermissions, roles, userRoles } from '../schema';
type TQueryResult = TRole & {
  permissions: string | null;
};

const roleSelectFields = {
  ...getTableColumns(roles),
  permissions: sql<string>`string_agg(${rolePermissions.permission}, ',')`.as(
    'permissions'
  )
};

const parseRole = (role: TQueryResult): TJoinedRole => ({
  ...role,
  permissions: role.permissions
    ? (role.permissions.split(',') as Permission[])
    : []
});

const getDefaultRole = async (): Promise<TRole | undefined> => {
  const [role] = await db
    .select()
    .from(roles)
    .where(eq(roles.isDefault, true))
    .limit(1);
  return role;
};

const getRole = async (roleId: number): Promise<TJoinedRole | undefined> => {
  const [role] = await db
    .select(roleSelectFields)
    .from(roles)
    .leftJoin(rolePermissions, sql`${roles.id} = ${rolePermissions.roleId}`)
    .where(sql`${roles.id} = ${roleId}`)
    .groupBy(roles.id)
    .limit(1);

  if (!role) return undefined;

  return parseRole(role);
};

const getUserRoleIds = async (userId: number): Promise<number[]> => {
  const userRoleRecords = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));

  return userRoleRecords.map((ur) => ur.roleId);
};

const getDefaultRoleForServer = async (
  serverId: number
): Promise<TRole | undefined> => {
  const [role] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.isDefault, true), eq(roles.serverId, serverId)))
    .limit(1);
  return role;
};

const getRolesForServer = async (
  serverId: number
): Promise<TJoinedRole[]> => {
  const results = await db
    .select(roleSelectFields)
    .from(roles)
    .leftJoin(rolePermissions, sql`${roles.id} = ${rolePermissions.roleId}`)
    .where(eq(roles.serverId, serverId))
    .groupBy(roles.id);

  return results.map(parseRole);
};

export {
  getDefaultRole,
  getDefaultRoleForServer,
  getRole,
  getRolesForServer,
  getUserRoleIds
};
