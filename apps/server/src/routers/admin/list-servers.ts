import { count, eq } from 'drizzle-orm';
import { db } from '../../db';
import { channels, serverMembers, servers, users } from '../../db/schema';
import { instanceOwnerProcedure } from '../../utils/procedures';

/**
 * Global server directory: every server on the instance with its owner
 * and headline counts, regardless of the operator's own memberships.
 */
const listServersRoute = instanceOwnerProcedure.query(async () => {
  const rows = await db
    .select({
      id: servers.id,
      publicId: servers.publicId,
      name: servers.name,
      description: servers.description,
      ownerId: servers.ownerId,
      ownerName: users.name,
      ownerDeletedAt: users.deletedAt,
      hasPassword: servers.password,
      discoverable: servers.discoverable,
      federatable: servers.federatable,
      enablePlugins: servers.enablePlugins,
      allowNewUsers: servers.allowNewUsers,
      createdAt: servers.createdAt
    })
    .from(servers)
    .leftJoin(users, eq(servers.ownerId, users.id))
    .orderBy(servers.id);

  const memberCounts = await db
    .select({ serverId: serverMembers.serverId, value: count() })
    .from(serverMembers)
    .groupBy(serverMembers.serverId);

  const channelCounts = await db
    .select({ serverId: channels.serverId, value: count() })
    .from(channels)
    .groupBy(channels.serverId);

  const byId = <T extends { serverId: number; value: number }>(list: T[]) =>
    new Map(list.map((r) => [r.serverId, r.value]));
  const members = byId(memberCounts);
  const chans = byId(channelCounts);

  return rows.map((s) => ({
    id: s.id,
    publicId: s.publicId,
    name: s.name,
    description: s.description,
    ownerId: s.ownerId,
    ownerName: s.ownerName,
    ownerDeleted: s.ownerDeletedAt != null,
    hasPassword: s.hasPassword != null && s.hasPassword !== '',
    discoverable: s.discoverable,
    federatable: s.federatable,
    enablePlugins: s.enablePlugins,
    allowNewUsers: s.allowNewUsers,
    createdAt: s.createdAt,
    memberCount: members.get(s.id) ?? 0,
    channelCount: chans.get(s.id) ?? 0
  }));
});

export { listServersRoute };
