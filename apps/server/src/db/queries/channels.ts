import {
  ChannelPermission,
  type TChannelUserPermissionsMap,
  type TLastReadMessageIdMap,
  type TMentionStateMap,
  type TReadStateMap
} from '@pulse/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '..';
import {
  channelReadStates,
  channelRolePermissions,
  channels,
  channelUserPermissions,
  messages,
  serverMembers,
  userRoles
} from '../schema';
import { getUserRoleIds } from './roles';
import { getServerById } from './servers';

const getAllChannelUserPermissions = async (
  userId: number,
  serverId?: number
): Promise<TChannelUserPermissionsMap> => {
  const roleIds = await getUserRoleIds(userId);
  const allChannels = serverId
    ? await db.select().from(channels).where(eq(channels.serverId, serverId))
    : await db.select().from(channels);

  const channelIds = serverId
    ? allChannels.map((c) => c.id)
    : undefined;

  const userPermissions = await db
    .select({
      channelId: channelUserPermissions.channelId,
      permission: channelUserPermissions.permission,
      allow: channelUserPermissions.allow
    })
    .from(channelUserPermissions)
    .where(
      channelIds && channelIds.length > 0
        ? and(
            eq(channelUserPermissions.userId, userId),
            inArray(channelUserPermissions.channelId, channelIds)
          )
        : eq(channelUserPermissions.userId, userId)
    );

  let rolePermissions: typeof userPermissions = [];

  if (roleIds.length > 0) {
    rolePermissions = await db
      .select({
        channelId: channelRolePermissions.channelId,
        permission: channelRolePermissions.permission,
        allow: channelRolePermissions.allow
      })
      .from(channelRolePermissions)
      .where(
        channelIds && channelIds.length > 0
          ? and(
              inArray(channelRolePermissions.roleId, roleIds),
              inArray(channelRolePermissions.channelId, channelIds)
            )
          : inArray(channelRolePermissions.roleId, roleIds)
      );
  }

  const userPermMap = new Map<number, Map<ChannelPermission, boolean>>();

  for (const perm of userPermissions) {
    if (!userPermMap.has(perm.channelId)) {
      userPermMap.set(perm.channelId, new Map());
    }

    userPermMap
      .get(perm.channelId)!
      .set(perm.permission as ChannelPermission, perm.allow);
  }

  const rolePermMap = new Map<number, Map<ChannelPermission, boolean>>();

  for (const perm of rolePermissions) {
    if (!rolePermMap.has(perm.channelId)) {
      rolePermMap.set(perm.channelId, new Map());
    }

    const channelMap = rolePermMap.get(perm.channelId)!;
    const existing = channelMap.get(perm.permission as ChannelPermission);

    channelMap.set(
      perm.permission as ChannelPermission,
      existing || perm.allow
    );
  }

  const allPermissionTypes = Object.values(ChannelPermission);

  const channelPermissions: Record<
    number,
    { channelId: number; permissions: Record<ChannelPermission, boolean> }
  > = {};

  for (const channel of allChannels) {
    const permissions: Record<string, boolean> = {};

    for (const permissionType of allPermissionTypes) {
      const userPerm = userPermMap.get(channel.id)?.get(permissionType);

      if (userPerm !== undefined) {
        permissions[permissionType] = userPerm;

        continue;
      }

      const rolePerm = rolePermMap.get(channel.id)?.get(permissionType);

      if (rolePerm !== undefined) {
        permissions[permissionType] = rolePerm;

        continue;
      }

      permissions[permissionType] = false;
    }

    channelPermissions[channel.id] = {
      channelId: channel.id,
      permissions: permissions as Record<ChannelPermission, boolean>
    };
  }

  return channelPermissions;
};

const getAffectedUserIdsForChannel = async (
  channelId: number,
  options?: {
    forceAllUsers?: boolean;
    permission?: ChannelPermission;
  }
): Promise<number[]> => {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, channelId))
    .limit(1);

  if (!channel) {
    return [];
  }

  // For public channels, return all members of this channel's server
  if (!channel.private || options?.forceAllUsers) {
    const members = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(eq(serverMembers.serverId, channel.serverId));

    return members.map((m) => m.userId);
  }

  // For private channels, filter by channel-specific permissions
  const permission = options?.permission;

  const usersWithDirectPerms = await db
    .select({ userId: channelUserPermissions.userId })
    .from(channelUserPermissions)
    .where(
      and(
        eq(channelUserPermissions.channelId, channelId),
        permission
          ? eq(channelUserPermissions.permission, permission)
          : undefined,
        permission ? eq(channelUserPermissions.allow, true) : undefined
      )
    );

  const rolesWithPerms = await db
    .select({ roleId: channelRolePermissions.roleId })
    .from(channelRolePermissions)
    .where(
      and(
        eq(channelRolePermissions.channelId, channelId),
        permission
          ? eq(channelRolePermissions.permission, permission)
          : undefined,
        permission ? eq(channelRolePermissions.allow, true) : undefined
      )
    );

  const roleIds = rolesWithPerms.map((r) => r.roleId);

  let usersWithRoles: { userId: number }[] = [];

  if (roleIds.length > 0) {
    usersWithRoles = await db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(inArray(userRoles.roleId, roleIds));
  }

  // Include server owner (they always have access to all channels)
  const server = await getServerById(channel.serverId);
  const userIdSet = new Set<number>();

  if (server?.ownerId) {
    userIdSet.add(server.ownerId);
  }

  usersWithDirectPerms.forEach((u) => userIdSet.add(u.userId));
  usersWithRoles.forEach((u) => userIdSet.add(u.userId));

  return Array.from(userIdSet);
};

const getChannelsReadStatesForUser = async (
  userId: number,
  channelId?: number,
  serverId?: number
): Promise<{ readStates: TReadStateMap; mentionStates: TMentionStateMap; lastReadMessageIds: TLastReadMessageIdMap }> => {
  const needsChannelJoin = !channelId && serverId;

  const query = db
    .select({
      channelId: messages.channelId,
      lastReadMessageId: sql<number | null>`MAX(${channelReadStates.lastReadMessageId})`.as('last_read_message_id'),
      unreadCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND ${channelReadStates.lastReadMessageId} IS NOT NULL
            AND ${messages.id} > ${channelReadStates.lastReadMessageId}
          THEN 1
        END)
      `.as('unread_count'),
      mentionCount: sql<number>`
        COUNT(CASE
          WHEN ${messages.userId} != ${userId}
            AND ${channelReadStates.lastReadMessageId} IS NOT NULL
            AND ${messages.id} > ${channelReadStates.lastReadMessageId}
            AND ${messages.mentionedUserIds}::jsonb @> ${sql`${JSON.stringify([userId])}::jsonb`}
          THEN 1
        END)
      `.as('mention_count')
    })
    .from(messages)
    .leftJoin(
      channelReadStates,
      and(
        eq(channelReadStates.channelId, messages.channelId),
        eq(channelReadStates.userId, userId)
      )
    );

  if (needsChannelJoin) {
    query.innerJoin(channels, eq(channels.id, messages.channelId));
  }

  const whereConditions: ReturnType<typeof eq>[] = [];
  if (channelId) whereConditions.push(eq(messages.channelId, channelId));
  if (needsChannelJoin) whereConditions.push(eq(channels.serverId, serverId));

  if (whereConditions.length > 0) {
    query.where(whereConditions.length === 1 ? whereConditions[0] : and(...whereConditions));
  }

  const results = await query.groupBy(messages.channelId);

  const readStates: TReadStateMap = {};
  const mentionStates: TMentionStateMap = {};
  const lastReadMessageIds: TLastReadMessageIdMap = {};

  for (const result of results) {
    readStates[result.channelId] = Number(result.unreadCount);
    lastReadMessageIds[result.channelId] = result.lastReadMessageId;
    const mc = Number(result.mentionCount);
    if (mc > 0) {
      mentionStates[result.channelId] = mc;
    }
  }

  return { readStates, mentionStates, lastReadMessageIds };
};

/**
 * Aggregate unread + mention counts across all child THREAD channels
 * of a given parent forum channel, for a single user.
 */
const getForumUnreadForUser = async (
  userId: number,
  forumChannelId: number
): Promise<{ unreadCount: number; mentionCount: number }> => {
  const [result] = await db
    .select({
      unreadCount: sql<number>`
        COALESCE(SUM(CASE
          WHEN ${messages.userId} != ${userId}
            AND ${channelReadStates.lastReadMessageId} IS NOT NULL
            AND ${messages.id} > ${channelReadStates.lastReadMessageId}
          THEN 1
        END), 0)
      `.as('unread_count'),
      mentionCount: sql<number>`
        COALESCE(SUM(CASE
          WHEN ${messages.userId} != ${userId}
            AND ${channelReadStates.lastReadMessageId} IS NOT NULL
            AND ${messages.id} > ${channelReadStates.lastReadMessageId}
            AND ${messages.mentionedUserIds}::jsonb @> ${sql`${JSON.stringify([userId])}::jsonb`}
          THEN 1
        END), 0)
      `.as('mention_count')
    })
    .from(messages)
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .leftJoin(
      channelReadStates,
      and(
        eq(channelReadStates.channelId, messages.channelId),
        eq(channelReadStates.userId, userId)
      )
    )
    .where(
      and(
        eq(channels.parentChannelId, forumChannelId),
        eq(channels.type, 'THREAD')
      )
    );

  return {
    unreadCount: Number(result?.unreadCount ?? 0),
    mentionCount: Number(result?.mentionCount ?? 0)
  };
};

export {
  getAffectedUserIdsForChannel,
  getAllChannelUserPermissions,
  getChannelsReadStatesForUser,
  getForumUnreadForUser
};
