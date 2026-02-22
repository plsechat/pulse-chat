import type { TJoinedServer, TServerSummary } from '@pulse/shared';
import { and, asc, count, eq, max, sql } from 'drizzle-orm';
import { db } from '..';
import {
  channelReadStates,
  channels,
  files,
  messages,
  serverMembers,
  servers
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

const addServerMember = async (serverId: number, userId: number) => {
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

export {
  addServerMember,
  getDiscoverableServers,
  getFirstServer,
  getServerById,
  getServerByPublicId,
  getServerMemberIds,
  getServerUnreadCount,
  getServerUnreadCounts,
  getServersByUserId,
  isServerMember,
  removeServerMember
};
