import type { PluginContext, TPluginMember } from '@pulse/plugin-sdk';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db';
import {
  files,
  roles,
  serverMembers,
  servers,
  userRoles,
  users
} from '../../db/schema';
import { parseActionInput, PluginActionError } from '../errors';

/**
 * `ctx.actions.members.list` — the roster a plugin may see: display
 * identity and this server's roles, nothing more. No e-mail, no auth
 * identity, no federation home: a plugin that needs to reach a member
 * does so through channel messages, never out of band.
 */

/** Rosters above this are paged by the client; a plugin gets the first page. */
const MAX_LISTED_MEMBERS = 5000;

const createMemberActions = (): PluginContext['actions']['members'] => {
  const list: PluginContext['actions']['members']['list'] = async (
    rawServerId
  ) => {
    const serverId = parseActionInput(z.number().int().positive(), rawServerId);

    const [server] = await db
      .select({ id: servers.id })
      .from(servers)
      .where(eq(servers.id, serverId))
      .limit(1);

    if (!server) {
      throw new PluginActionError('NOT_FOUND', 'Server not found');
    }

    // Tombstoned accounts stay members for history but are nobody a
    // plugin can address; they are left out like the roster does.
    const rows = await db
      .select({
        id: users.id,
        publicId: users.publicId,
        name: users.name,
        nickname: serverMembers.nickname,
        avatarName: files.name
      })
      .from(serverMembers)
      .innerJoin(users, eq(serverMembers.userId, users.id))
      .leftJoin(files, eq(users.avatarId, files.id))
      .where(and(eq(serverMembers.serverId, serverId), isNull(users.deletedAt)))
      .orderBy(asc(serverMembers.joinedAt), asc(users.id))
      .limit(MAX_LISTED_MEMBERS);

    if (rows.length === 0) return [];

    // Only THIS server's roles: a role id from another server the member
    // also belongs to must not leak into the answer.
    const roleRows = await db
      .select({
        userId: userRoles.userId,
        id: roles.id,
        name: roles.name,
        position: roles.position
      })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(
        and(
          eq(roles.serverId, serverId),
          inArray(
            userRoles.userId,
            rows.map((r) => r.id)
          )
        )
      );

    const rolesByUser = new Map<number, { id: number; name: string; position: number }[]>();

    for (const role of roleRows) {
      const bucket = rolesByUser.get(role.userId) ?? [];
      bucket.push({ id: role.id, name: role.name, position: role.position });
      rolesByUser.set(role.userId, bucket);
    }

    return rows.map((row): TPluginMember => {
      const memberRoles = (rolesByUser.get(row.id) ?? [])
        .sort((a, b) => b.position - a.position || a.id - b.id)
        .map(({ id, name }) => ({ id, name }));

      return {
        id: row.id,
        publicId: row.publicId,
        name: row.name,
        ...(row.nickname ? { nickname: row.nickname } : {}),
        ...(row.avatarName ? { avatarUrl: `/public/${row.avatarName}` } : {}),
        roles: memberRoles
      };
    });
  };

  return { list };
};

export { createMemberActions };
