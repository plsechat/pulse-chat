import {
  ChannelPermission,
  type TChannelUserPermissionsMap,
  type TLastReadMessageIdMap,
  type TMentionStateMap,
  type TReadStateMap
} from '@pulse/shared';
import { and, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
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

/**
 * Effective channel permissions of one user, for every channel (of one
 * server, or of the whole instance). Evaluation order, per channel and
 * permission: the channel's default — allow on a public channel, deny on
 * a private one — then role overrides (any held role allowing wins over
 * roles denying), then a user override, which beats everything. Owner
 * bypass is NOT applied here; callers that need it check servers.ownerId
 * themselves (hasChannelPermission, getAffectedUserIdsForChannel).
 */
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

      permissions[permissionType] = !channel.private;
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

  // For public channels, every member of the server — minus the ones an
  // override explicitly denies the requested permission (a user row, or
  // every held role denying with none allowing). The server owner is
  // never excluded.
  if (!channel.private || options?.forceAllUsers) {
    const members = await db
      .select({ userId: serverMembers.userId })
      .from(serverMembers)
      .where(eq(serverMembers.serverId, channel.serverId));

    const memberIds = members.map((m) => m.userId);
    const publicPermission = options?.forceAllUsers ? undefined : options?.permission;

    if (!publicPermission) return memberIds;

    return filterPublicChannelDenials(
      channel.id,
      channel.serverId,
      publicPermission,
      memberIds
    );
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

const filterPublicChannelDenials = async (
  channelId: number,
  serverId: number,
  permission: ChannelPermission,
  memberIds: number[]
): Promise<number[]> => {
  const [userRows, roleRows] = await Promise.all([
    db
      .select({
        userId: channelUserPermissions.userId,
        allow: channelUserPermissions.allow
      })
      .from(channelUserPermissions)
      .where(
        and(
          eq(channelUserPermissions.channelId, channelId),
          eq(channelUserPermissions.permission, permission)
        )
      ),
    db
      .select({
        roleId: channelRolePermissions.roleId,
        allow: channelRolePermissions.allow
      })
      .from(channelRolePermissions)
      .where(
        and(
          eq(channelRolePermissions.channelId, channelId),
          eq(channelRolePermissions.permission, permission)
        )
      )
  ]);

  const hasDenial =
    userRows.some((r) => !r.allow) || roleRows.some((r) => !r.allow);
  if (!hasDenial) return memberIds;

  const userOverride = new Map(userRows.map((r) => [r.userId, r.allow]));
  const roleOverride = new Map(roleRows.map((r) => [r.roleId, r.allow]));

  const holders = await db
    .select({ userId: userRoles.userId, roleId: userRoles.roleId })
    .from(userRoles)
    .where(inArray(userRoles.roleId, [...roleOverride.keys()]));

  const roleDecision = new Map<number, boolean>();
  for (const { userId, roleId } of holders) {
    const allow = roleOverride.get(roleId)!;
    roleDecision.set(userId, (roleDecision.get(userId) ?? false) || allow);
  }

  const server = await getServerById(serverId);

  return memberIds.filter((userId) => {
    if (server?.ownerId === userId) return true;
    const direct = userOverride.get(userId);
    if (direct !== undefined) return direct;
    return roleDecision.get(userId) ?? true;
  });
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

type TUnreadCounts = { count: number; mentionCount: number };

/**
 * Unread + mention counts of ONE channel for MANY users in a single
 * grouped statement — the message fan-out path (publishMessage) used to
 * run the full per-channel aggregate once per recipient per message,
 * i.e. O(members x messages-in-channel) on the single pool.
 *
 * Semantics match getChannelsReadStatesForUser exactly: only messages
 * newer than the user's last-read marker and not authored by the user
 * count, and a user with no read-state row (or a NULL marker) reads as
 * 0 unread. Users absent from the returned map are therefore 0/0.
 */
const getChannelUnreadForUsers = async (
  userIds: number[],
  channelId: number
): Promise<Map<number, TUnreadCounts>> => {
  const result = new Map<number, TUnreadCounts>();
  if (userIds.length === 0) return result;

  const rows = await db
    .select({
      userId: channelReadStates.userId,
      unreadCount: sql<number>`
        COUNT(*) FILTER (WHERE ${messages.userId} != ${channelReadStates.userId})
      `.as('unread_count'),
      mentionCount: sql<number>`
        COUNT(*) FILTER (
          WHERE ${messages.userId} != ${channelReadStates.userId}
            AND ${messages.mentionedUserIds}::jsonb @> jsonb_build_array(${channelReadStates.userId})
        )
      `.as('mention_count')
    })
    .from(channelReadStates)
    .innerJoin(
      messages,
      and(
        eq(messages.channelId, channelReadStates.channelId),
        gt(messages.id, channelReadStates.lastReadMessageId)
      )
    )
    .where(
      and(
        eq(channelReadStates.channelId, channelId),
        inArray(channelReadStates.userId, userIds),
        isNotNull(channelReadStates.lastReadMessageId)
      )
    )
    .groupBy(channelReadStates.userId);

  for (const row of rows) {
    result.set(row.userId, {
      count: Number(row.unreadCount),
      mentionCount: Number(row.mentionCount)
    });
  }

  return result;
};

/**
 * Batch twin of getForumUnreadForUser: aggregated unread + mention
 * counts across every child THREAD of one forum, for many users, in one
 * statement. Same per-user semantics as the single-user variant.
 */
const getForumUnreadForUsers = async (
  userIds: number[],
  forumChannelId: number
): Promise<Map<number, TUnreadCounts>> => {
  const result = new Map<number, TUnreadCounts>();
  if (userIds.length === 0) return result;

  const rows = await db
    .select({
      userId: channelReadStates.userId,
      unreadCount: sql<number>`
        COUNT(*) FILTER (WHERE ${messages.userId} != ${channelReadStates.userId})
      `.as('unread_count'),
      mentionCount: sql<number>`
        COUNT(*) FILTER (
          WHERE ${messages.userId} != ${channelReadStates.userId}
            AND ${messages.mentionedUserIds}::jsonb @> jsonb_build_array(${channelReadStates.userId})
        )
      `.as('mention_count')
    })
    .from(channelReadStates)
    .innerJoin(
      channels,
      and(
        eq(channels.id, channelReadStates.channelId),
        eq(channels.parentChannelId, forumChannelId),
        eq(channels.type, 'THREAD')
      )
    )
    .innerJoin(
      messages,
      and(
        eq(messages.channelId, channelReadStates.channelId),
        gt(messages.id, channelReadStates.lastReadMessageId)
      )
    )
    .where(
      and(
        inArray(channelReadStates.userId, userIds),
        isNotNull(channelReadStates.lastReadMessageId)
      )
    )
    .groupBy(channelReadStates.userId);

  for (const row of rows) {
    result.set(row.userId, {
      count: Number(row.unreadCount),
      mentionCount: Number(row.mentionCount)
    });
  }

  return result;
};

/**
 * A channel row as it may leave the server. `fileAccessToken` is the
 * per-channel secret that mints file tokens and must never reach a
 * client; it is blanked rather than dropped so the TChannel shape the
 * clients store stays intact (preview sessions already model "no token"
 * as an empty string).
 */
const toWireChannel = <T extends { fileAccessToken: string }>(
  channel: T
): T => ({ ...channel, fileAccessToken: '' });

export {
  getAffectedUserIdsForChannel,
  getAllChannelUserPermissions,
  getChannelsReadStatesForUser,
  getChannelUnreadForUsers,
  getForumUnreadForUser,
  getForumUnreadForUsers,
  toWireChannel
};
