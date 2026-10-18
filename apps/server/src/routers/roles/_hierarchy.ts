import { Permission } from '@pulse/shared';
import { getHighestRolePosition } from '../../db/queries/roles';
import { isServerOwner } from '../../db/queries/servers';
import { invariant } from '../../utils/invariant';
import { getUserRoles } from '../users/get-user-roles';

/**
 * Role-hierarchy ceiling of a caller in one server.
 *
 * Without a hierarchy, MANAGE_ROLES let a moderator put every
 * permission on their own role and MANAGE_USERS let them hand any role
 * to anyone — both are full escalation to owner-equivalent power. The
 * rule enforced through this helper:
 *
 *   - a caller may only create / edit / assign / delete / reorder roles
 *     whose position is STRICTLY below their own highest role;
 *   - a caller may only set permissions that are a subset of what they
 *     effectively hold;
 *   - the server owner (servers.ownerId or the owner role) bypasses both.
 */
type TRoleCeiling = {
  owner: boolean;
  /** Highest position the caller holds; -Infinity when they hold none. */
  top: number;
  permissions: Set<Permission>;
};

const getRoleCeiling = async (
  userId: number,
  serverId: number
): Promise<TRoleCeiling> => {
  if (await isServerOwner(serverId, userId)) {
    return {
      owner: true,
      top: Number.POSITIVE_INFINITY,
      permissions: new Set(Object.values(Permission))
    };
  }

  const [top, roles] = await Promise.all([
    getHighestRolePosition(userId, serverId),
    getUserRoles(userId, serverId)
  ]);

  const permissions = new Set<Permission>();
  for (const role of roles) {
    for (const permission of role.permissions) permissions.add(permission);
  }

  return {
    owner: false,
    top: top ?? Number.NEGATIVE_INFINITY,
    permissions
  };
};

const isBelowCeiling = (ceiling: TRoleCeiling, position: number) =>
  ceiling.owner || position < ceiling.top;

const assertCanManageRole = (
  ceiling: TRoleCeiling,
  role: { position: number }
) => {
  invariant(isBelowCeiling(ceiling, role.position), {
    code: 'FORBIDDEN',
    message: 'You can only manage roles below your highest role'
  });
};

const assertPermissionsWithinCeiling = (
  ceiling: TRoleCeiling,
  permissions: Permission[]
) => {
  invariant(
    ceiling.owner || permissions.every((p) => ceiling.permissions.has(p)),
    {
      code: 'FORBIDDEN',
      message: 'You cannot grant permissions you do not hold'
    }
  );
};

export {
  assertCanManageRole,
  assertPermissionsWithinCeiling,
  getRoleCeiling,
  isBelowCeiling
};
export type { TRoleCeiling };
