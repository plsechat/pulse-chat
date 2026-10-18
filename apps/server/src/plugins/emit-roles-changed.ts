import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { roles, userRoles } from '../db/schema';
import { eventBus } from './event-bus';

/**
 * Tell plugins a member's role set in `serverId` changed, with the full
 * set they hold there afterwards. One helper for every site that writes
 * user_roles (grant, revoke, role deletion fallback, ownership transfer)
 * so the payload is computed the same way everywhere: scoped to the
 * server's own roles, never a role id from another server the member
 * also belongs to.
 */
const emitMemberRolesChanged = async (userId: number, serverId: number) => {
  const rows = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(and(eq(userRoles.userId, userId), eq(roles.serverId, serverId)));

  await eventBus.emit('member:roles_changed', {
    userId,
    serverId,
    roleIds: rows.map((r) => r.roleId).sort((a, b) => a - b)
  });
};

export { emitMemberRolesChanged };
