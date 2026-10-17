import { OWNER_ROLE_ID } from '@pulse/shared';
import type { TJoinedServer, TServerSummary } from '../../types';
import { and, asc, eq, inArray, max, or, sql } from 'drizzle-orm';
import { db } from '..';
import {
  channelReadStates,
  channels,
  channelUserPermissions,
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

/**
 * Members of a server, as a correlated scalar so list queries carry the
 * count in the same statement instead of one COUNT per row.
 */
const memberCountOf = sql<number>`
  (SELECT count(*) FROM ${serverMembers}
    WHERE ${serverMembers.serverId} = ${servers.id})
`.as('member_count');

const getServerById = async (
  serverId: number
): Promise<TJoinedServer | undefined> => {
  const [row] = await db
    .select({ server: servers, logo: files })
    .from(servers)
    .leftJoin(files, eq(servers.logoId, files.id))
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!row) return undefined;

  return {
    ...row.server,
    logo: row.logo
  };
};

const getServersByUserId = async (
  userId: number
): Promise<TServerSummary[]> => {
  // Logo and member count ride along in the one statement (this used to
  // be 1 + 2n queries for n servers).
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      publicId: servers.publicId,
      ownerId: servers.ownerId,
      description: servers.description,
      logo: files,
      memberCount: memberCountOf
    })
    .from(serverMembers)
    .innerJoin(servers, eq(serverMembers.serverId, servers.id))
    .leftJoin(files, eq(servers.logoId, files.id))
    .where(eq(serverMembers.userId, userId))
    .orderBy(asc(serverMembers.position));

  return rows.map(
    (row): TServerSummary => ({
      id: row.id,
      name: row.name,
      publicId: row.publicId,
      logo: row.logo,
      memberCount: Number(row.memberCount),
      ownerId: row.ownerId,
      // Carried so the client's live summary (rail, deck tabs, Discover
      // card) starts from the same description SERVER_SETTINGS_UPDATE
      // later keeps current.
      description: row.description
    })
  );
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

/**
 * Take a user out of a server completely: the membership row, every role
 * they hold IN THAT SERVER and their per-channel overrides there, in one
 * transaction. Leave, kick and ban all go through here. Leaving only the
 * membership row behind let a kicked moderator rejoin by invite with
 * every role intact (the join path only adds the default role), and let
 * a leaver keep acting through roles that still existed.
 */
const removeServerMember = async (serverId: number, userId: number) => {
  await db.transaction(async (tx) => {
    await tx
      .delete(serverMembers)
      .where(
        and(
          eq(serverMembers.serverId, serverId),
          eq(serverMembers.userId, userId)
        )
      );

    await tx.delete(userRoles).where(
      and(
        eq(userRoles.userId, userId),
        inArray(
          userRoles.roleId,
          tx.select({ id: roles.id }).from(roles).where(eq(roles.serverId, serverId))
        )
      )
    );

    await tx.delete(channelUserPermissions).where(
      and(
        eq(channelUserPermissions.userId, userId),
        inArray(
          channelUserPermissions.channelId,
          tx
            .select({ id: channels.id })
            .from(channels)
            .where(eq(channels.serverId, serverId))
        )
      )
    );
  });
};

const getFirstServer = async (): Promise<TJoinedServer | undefined> => {
  const [row] = await db
    .select({ server: servers, logo: files })
    .from(servers)
    .leftJoin(files, eq(servers.logoId, files.id))
    .orderBy(servers.id)
    .limit(1);

  if (!row) return undefined;

  return {
    ...row.server,
    logo: row.logo
  };
};

const getDiscoverableServers = async (
  userId: number
): Promise<(TServerSummary & { joined: boolean })[]> => {
  // Every discoverable server with its logo, member count and the
  // caller's membership flag in ONE statement (was 2 + 2n queries).
  const rows = await db
    .select({
      id: servers.id,
      name: servers.name,
      publicId: servers.publicId,
      ownerId: servers.ownerId,
      description: servers.description,
      password: servers.password,
      logo: files,
      memberCount: memberCountOf,
      joined: sql<boolean>`
        EXISTS (SELECT 1 FROM ${serverMembers}
          WHERE ${serverMembers.serverId} = ${servers.id}
            AND ${serverMembers.userId} = ${userId})
      `.as('joined')
    })
    .from(servers)
    .leftJoin(files, eq(servers.logoId, files.id))
    .where(eq(servers.discoverable, true));

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    publicId: row.publicId,
    logo: row.logo,
    memberCount: Number(row.memberCount),
    ownerId: row.ownerId,
    description: row.description,
    hasPassword: !!row.password,
    joined: row.joined === true
  }));
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
            AND ${messages.deletedAt} IS NULL
            AND (${channelReadStates.lastReadMessageId} IS NULL
              OR ${messages.id} > ${channelReadStates.lastReadMessageId})
          THEN 1
        END)
      `.as('unread_count'),
      mentionCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND ${messages.deletedAt} IS NULL
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
            AND ${messages.deletedAt} IS NULL
            AND (${channelReadStates.lastReadMessageId} IS NULL
              OR ${messages.id} > ${channelReadStates.lastReadMessageId})
          THEN 1
        END)
      `.as('unread_count'),
      mentionCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND ${messages.deletedAt} IS NULL
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
