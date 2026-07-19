import { OWNER_ROLE_ID, type TJoinedServer, type TServerSummary } from '@pulse/shared';
import { and, asc, count, eq, inArray, max, or, sql } from 'drizzle-orm';
import { db } from '..';
import {
  channelReadStates,
  channels,
  dmChannelMembers,
  files,
  friendships,
  invites,
  messages,
  roles,
  serverMembers,
  servers,
  userRoles,
  users
} from '../schema';

const getServerById = async (
  serverId: number
): Promise<TJoinedServer | undefined> => {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) return undefined;

  const logo = server.logoId
    ? (
        await db
          .select()
          .from(files)
          .where(eq(files.id, server.logoId))
          .limit(1)
      )[0]
    : undefined;

  return {
    ...server,
    logo: logo ?? null
  };
};

const getServerByPublicId = async (
  publicId: string
): Promise<TJoinedServer | undefined> => {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.publicId, publicId))
    .limit(1);

  if (!server) return undefined;

  const logo = server.logoId
    ? (
        await db
          .select()
          .from(files)
          .where(eq(files.id, server.logoId))
          .limit(1)
      )[0]
    : undefined;

  return {
    ...server,
    logo: logo ?? null
  };
};

const getServersByUserId = async (
  userId: number
): Promise<TServerSummary[]> => {
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      publicId: servers.publicId,
      logoId: servers.logoId,
      ownerId: servers.ownerId
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .where(eq(serverMembers.userId, userId))
    .orderBy(asc(serverMembers.position));

  const results: TServerSummary[] = [];

  for (const row of rows) {
    const logo = row.logoId
      ? (
          await db
            .select()
            .from(files)
            .where(eq(files.id, row.logoId))
            .limit(1)
        )[0]
      : undefined;

    const result = await db
      .select({ count: count() })
      .from(serverMembers)
      .where(eq(serverMembers.serverId, row.id));

    const memberCount = result[0]?.count ?? 0;

    results.push({
      id: row.id,
      name: row.name,
      publicId: row.publicId,
      logo: logo ?? null,
      memberCount,
      ownerId: row.ownerId
    });
  }

  return results;
};

const getServerMemberIds = async (serverId: number): Promise<number[]> => {
  const rows = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(eq(serverMembers.serverId, serverId));

  return rows.map((r) => r.userId);
};

const isServerMember = async (
  serverId: number,
  userId: number
): Promise<boolean> => {
  const [row] = await db
    .select({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .limit(1);

  return !!row;
};

const addServerMember = async (
  serverId: number,
  userId: number,
  inviteId?: number
) => {
  const [row] = await db
    .select({ maxPos: max(serverMembers.position) })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));

  const nextPosition = (row?.maxPos ?? -1) + 1;

  await db
    .insert(serverMembers)
    .values({
      serverId,
      userId,
      inviteId: inviteId ?? null,
      joinedAt: Date.now(),
      position: nextPosition
    })
    .onConflictDoNothing();
};

const removeServerMember = async (serverId: number, userId: number) => {
  await db
    .delete(serverMembers)
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    );
};

const getFirstServer = async (): Promise<TJoinedServer | undefined> => {
  const [server] = await db.select().from(servers).orderBy(servers.id).limit(1);

  if (!server) return undefined;

  const logo = server.logoId
    ? (
        await db
          .select()
          .from(files)
          .where(eq(files.id, server.logoId))
          .limit(1)
      )[0]
    : undefined;

  return {
    ...server,
    logo: logo ?? null
  };
};

const getDiscoverableServers = async (
  userId: number
): Promise<(TServerSummary & { joined: boolean })[]> => {
  // Get server IDs the user has already joined
  const joinedRows = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId));

  const joinedIds = new Set(joinedRows.map((r) => r.serverId));

  // Query all discoverable servers
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      publicId: servers.publicId,
      logoId: servers.logoId,
      ownerId: servers.ownerId,
      description: servers.description,
      password: servers.password
    })
    .from(servers)
    .where(eq(servers.discoverable, true));

  const results: (TServerSummary & { joined: boolean })[] = [];

  for (const row of rows) {
    const logo = row.logoId
      ? (
          await db
            .select()
            .from(files)
            .where(eq(files.id, row.logoId))
            .limit(1)
        )[0]
      : undefined;

    const result = await db
      .select({ count: count() })
      .from(serverMembers)
      .where(eq(serverMembers.serverId, row.id));

    const memberCount = result[0]?.count ?? 0;

    results.push({
      id: row.id,
      name: row.name,
      publicId: row.publicId,
      logo: logo ?? null,
      memberCount,
      ownerId: row.ownerId,
      description: row.description,
      hasPassword: !!row.password,
      joined: joinedIds.has(row.id)
    });
  }

  return results;
};

const getServerUnreadCounts = async (
  userId: number
): Promise<{ unreadCounts: Record<number, number>; mentionCounts: Record<number, number> }> => {
  const results = await db
    .select({
      serverId: channels.serverId,
      unreadCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND (${channelReadStates.lastReadMessageId} IS NULL
              OR ${messages.id} > ${channelReadStates.lastReadMessageId})
          THEN 1
        END)
      `.as('unread_count'),
      mentionCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND (${channelReadStates.lastReadMessageId} IS NULL
              OR ${messages.id} > ${channelReadStates.lastReadMessageId})
            AND ${messages.mentionedUserIds}::jsonb @> ${sql`${JSON.stringify([userId])}::jsonb`}
            AND (${messages.mentionsAll} IS NOT TRUE)
          THEN 1
        END)
      `.as('mention_count')
    })
    .from(channels)
    .innerJoin(
      serverMembers,
      and(
        eq(serverMembers.serverId, channels.serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .innerJoin(messages, eq(messages.channelId, channels.id))
    .leftJoin(
      channelReadStates,
      and(
        eq(channelReadStates.channelId, channels.id),
        eq(channelReadStates.userId, userId)
      )
    )
    .groupBy(channels.serverId);

  const unreadCounts: Record<number, number> = {};
  const mentionCounts: Record<number, number> = {};

  for (const row of results) {
    const c = Number(row.unreadCount);
    if (c > 0) {
      unreadCounts[row.serverId] = c;
    }
    const m = Number(row.mentionCount);
    if (m > 0) {
      mentionCounts[row.serverId] = m;
    }
  }

  return { unreadCounts, mentionCounts };
};

const getServerUnreadCount = async (
  userId: number,
  serverId: number
): Promise<{ unreadCount: number; mentionCount: number }> => {
  const [result] = await db
    .select({
      unreadCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND (${channelReadStates.lastReadMessageId} IS NULL
              OR ${messages.id} > ${channelReadStates.lastReadMessageId})
          THEN 1
        END)
      `.as('unread_count'),
      mentionCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND (${channelReadStates.lastReadMessageId} IS NULL
              OR ${messages.id} > ${channelReadStates.lastReadMessageId})
            AND ${messages.mentionedUserIds}::jsonb @> ${sql`${JSON.stringify([userId])}::jsonb`}
            AND (${messages.mentionsAll} IS NOT TRUE)
          THEN 1
        END)
      `.as('mention_count')
    })
    .from(channels)
    .innerJoin(messages, eq(messages.channelId, channels.id))
    .leftJoin(
      channelReadStates,
      and(
        eq(channelReadStates.channelId, channels.id),
        eq(channelReadStates.userId, userId)
      )
    )
    .where(eq(channels.serverId, serverId));

  return {
    unreadCount: Number(result?.unreadCount ?? 0),
    mentionCount: Number(result?.mentionCount ?? 0)
  };
};

const getCoMemberIds = async (userId: number): Promise<number[]> => {
  const rows = await db
    .selectDistinct({ userId: serverMembers.userId })
    .from(serverMembers)
    .where(
      inArray(
        serverMembers.serverId,
        db
          .select({ serverId: serverMembers.serverId })
          .from(serverMembers)
          .where(eq(serverMembers.userId, userId))
      )
    );

  return rows.map((r) => r.userId).filter((id) => id !== userId);
};

/**
 * Everyone who should see `userId`'s presence transitions: co-members of
 * shared servers, members of shared DM channels, and friends. Presence
 * events fanned only to server co-members left DM partners and friends
 * with a permanently stale status — the client defaults a missing status
 * to OFFLINE, which is exactly the "everyone in DMs looks offline" bug.
 */
const getPresenceInterestedIds = async (userId: number): Promise<number[]> => {
  const [coMemberIds, dmRows, friendRows] = await Promise.all([
    getCoMemberIds(userId),
    db
      .selectDistinct({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(
        inArray(
          dmChannelMembers.dmChannelId,
          db
            .select({ dmChannelId: dmChannelMembers.dmChannelId })
            .from(dmChannelMembers)
            .where(eq(dmChannelMembers.userId, userId))
        )
      ),
    db
      .select({ userId: friendships.userId, friendId: friendships.friendId })
      .from(friendships)
      .where(
        or(eq(friendships.userId, userId), eq(friendships.friendId, userId))
      )
  ]);

  const ids = new Set<number>(coMemberIds);
  for (const row of dmRows) ids.add(row.userId);
  for (const row of friendRows) {
    ids.add(row.userId);
    ids.add(row.friendId);
  }
  ids.delete(userId);

  return [...ids];
};

/**
 * True if `userId` owns `serverId`. Considers both:
 *   - servers.owner_id (canonical, set by Phase 3 first-user-claim and
 *     servers/create), and
 *   - the per-server Owner role (legacy fallback for the seeded server
 *     which had owner_id = null pre-Phase-3 and was claimed via the now-
 *     removed secret-token route, plus servers created via servers/create
 *     that grant the owner role in lockstep).
 *
 * Either signal is sufficient — the audit's owner-protection rule
 * (pulse-rule-owner-protection.md) treats them as equivalent.
 */
const isServerOwner = async (
  serverId: number,
  userId: number
): Promise<boolean> => {
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);
  if (server?.ownerId === userId) return true;

  // Server-scoped owner-role check: a userRole row for this user pointing
  // at the *Owner* role of *this* server. Joining roles to filter by
  // serverId guards against role.id=OWNER_ROLE_ID being interpreted as
  // global — OWNER_ROLE_ID just happens to be 1 because it's the bootstrap
  // server's owner role.
  const [match] = await db
    .select({ id: userRoles.userId })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(
      and(
        eq(userRoles.userId, userId),
        eq(roles.serverId, serverId),
        eq(userRoles.roleId, OWNER_ROLE_ID)
      )
    )
    .limit(1);

  return !!match;
};

/**
 * True iff `userId` owns the instance's first (lowest-id, bootstrap)
 * server — i.e. the operator who set the instance up. This is the
 * "original server owner" that governs instance-level federation:
 * enabling federation and peering with other instances are theirs alone,
 * never a mere MANAGE_SETTINGS holder or a user who spun up their own
 * server (and is therefore its owner with all permissions).
 */
const isInstanceOwner = async (userId: number): Promise<boolean> => {
  const [server] = await db
    .select({ ownerId: servers.ownerId })
    .from(servers)
    .orderBy(servers.id)
    .limit(1);

  return server?.ownerId != null && server.ownerId === userId;
};

const sharesServerWith = async (
  userId1: number,
  userId2: number
): Promise<boolean> => {
  const sm1 = db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .where(eq(serverMembers.userId, userId1))
    .as('sm1');

  const [row] = await db
    .select({ serverId: serverMembers.serverId })
    .from(serverMembers)
    .innerJoin(sm1, eq(sm1.serverId, serverMembers.serverId))
    .where(eq(serverMembers.userId, userId2))
    .limit(1);

  return !!row;
};

/**
 * How a member joined: the invite they used (if recorded) and who created
 * it. Null for pre-attribution members, open joins, and the owner.
 */
const getJoinMethod = async (serverId: number, userId: number) => {
  const [row] = await db
    .select({
      inviteCode: invites.code,
      inviterId: invites.creatorId,
      inviterName: users.name
    })
    .from(serverMembers)
    .leftJoin(invites, eq(serverMembers.inviteId, invites.id))
    .leftJoin(users, eq(invites.creatorId, users.id))
    .where(
      and(
        eq(serverMembers.serverId, serverId),
        eq(serverMembers.userId, userId)
      )
    )
    .limit(1);

  return row?.inviteCode
    ? {
        inviteCode: row.inviteCode,
        inviterId: row.inviterId,
        inviterName: row.inviterName
      }
    : null;
};

export {
  getJoinMethod,
  addServerMember,
  getCoMemberIds,
  getDiscoverableServers,
  getFirstServer,
  getPresenceInterestedIds,
  getServerById,
  getServerByPublicId,
  getServerMemberIds,
  getServerUnreadCount,
  getServerUnreadCounts,
  getServersByUserId,
  isInstanceOwner,
  isServerMember,
  isServerOwner,
  removeServerMember,
  sharesServerWith
};
