import type { ChannelPermission, Permission } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { getAllChannelUserPermissions } from '../db/queries/channels';
import { isServerMember } from '../db/queries/servers';
import { servers } from '../db/schema';
import { getUserRoles } from '../routers/users/get-user-roles';

/**
 * Permission checks for a user who is NOT the connection: the cron that
 * posts a scheduled message as its author, a follow that checks the
 * caller's standing in a server other than the active one. Same
 * precedence as ctx.hasPermission / ctx.hasChannelPermission (owner
 * bypass, then roles; channel overrides over the public/private
 * default) but uncached — these run once per cron row or settings
 * call, not per message. Membership is checked explicitly: a user who
 * left keeps no roles, but a public channel's default would still read
 * as "allowed" without it.
 */
const userHasServerPermission = async (
  userId: number,
  serverId: number,
  permission: Permission
): Promise<boolean> => {
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) return false;
  if (server.ownerId === userId) return true;
  if (!(await isServerMember(serverId, userId))) return false;

  const roles = await getUserRoles(userId, serverId);

  return roles.some((role) => role.permissions.includes(permission));
};

const userHasChannelPermission = async (
  userId: number,
  serverId: number,
  channelId: number,
  permission: ChannelPermission
): Promise<boolean> => {
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) return false;
  if (server.ownerId === userId) return true;
  if (!(await isServerMember(serverId, userId))) return false;

  const map = await getAllChannelUserPermissions(userId, serverId);

  return map[channelId]?.permissions[permission] === true;
};

export { userHasChannelPermission, userHasServerPermission };
