import { eq } from 'drizzle-orm';
import { db } from '..';
import { invariant } from '../../utils/invariant';
import { getDefaultRoleForServer } from '../queries/roles';
import { userRoles } from '../schema';

/**
 * Strip `roleId` from everyone holding it and make sure each of them
 * still holds the default role of `serverId` — the server the role
 * belongs to. Scoped to that server: on a multi-server instance the
 * fallback must never hand out another server's default role.
 */
const fallbackUsersToDefaultRole = async (roleId: number, serverId: number) => {
  const defaultRole = await getDefaultRoleForServer(serverId);

  invariant(defaultRole, {
    code: 'NOT_FOUND',
    message: 'Default role not found'
  });

  await db.transaction(async (tx) => {
    const affectedUsers = await tx
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId));

    await tx.delete(userRoles).where(eq(userRoles.roleId, roleId));

    if (affectedUsers.length === 0) return;

    const now = Date.now();
    await tx
      .insert(userRoles)
      .values(
        affectedUsers.map(({ userId }) => ({
          userId,
          roleId: defaultRole.id,
          createdAt: now
        }))
      )
      // Users that already held the default role keep their existing row.
      .onConflictDoNothing();
  });
};

export { fallbackUsersToDefaultRole };
