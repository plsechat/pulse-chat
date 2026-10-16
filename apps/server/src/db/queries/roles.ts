import type { Permission } from '@pulse/shared';
import type { TJoinedRole, TRole } from '../../types';
import { and, eq, getTableColumns, max, sql } from 'drizzle-orm';
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

/**
 * The default role of ONE server. There is no instance-wide default:
 * every server seeds its own, and a lookup that ignored the server
 * picked an arbitrary one on multi-server instances (set-default and
 * delete-role then acted across servers).
 */
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

/**
 * The highest role position a user holds in a server, or undefined when
 * they hold no role there. This is the user's ceiling in the role
 * hierarchy: they may only act on roles strictly below it.
 */
const getHighestRolePosition = async (
  userId: number,
  serverId: number
): Promise<number | undefined> => {
  const [row] = await db
    .select({ top: max(roles.position) })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(userRoles.userId, userId), eq(roles.serverId, serverId)));

  return row?.top ?? undefined;
};

export {
  getDefaultRoleForServer,
  getHighestRolePosition,
  getRole,
  getRolesForServer,
  getUserRoleIds
};
