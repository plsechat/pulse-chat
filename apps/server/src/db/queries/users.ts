import { type TStorageData } from '@pulse/shared';
import type {
  TFile,
  TFileRef,
  TJoinedPublicUser,
  TJoinedUser
} from '../../types';
import { count, eq, inArray, sql, sum } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '..';
import { authBackend } from '../../utils/auth';
import { looksLikeOidcSession, verifySessionToken } from '../../utils/oidc';
import { federationInstances, files, roles, serverMembers, userRoles, users } from '../schema';
import { isPluginActorAuthId } from '../../plugins/actor-id';

const slimFile = (file: TFile | null): TFileRef | null =>
  file ? { id: file.id, name: file.name } : null;

/**
 * Resolve the persisted profile-status fields for a projection, applying
 * the custom-status auto-expiry lazily: once customStatusExpiresAt has
 * passed, the status and its emoji read as cleared without a cron ever
 * touching the row.
 */
const statusTrio = (row: {
  customStatus: string | null;
  customStatusEmoji: string | null;
  customStatusExpiresAt: number | null;
  pronouns: string | null;
}) => {
  const expired =
    row.customStatusExpiresAt != null &&
    row.customStatusExpiresAt <= Date.now();
  return {
    pronouns: row.pronouns,
    customStatus: expired ? null : row.customStatus,
    customStatusEmoji: expired ? null : row.customStatusEmoji
  };
};

/**
 * Shape of the per-user roles aggregate: `json_agg` over user_roles in a
 * correlated subquery, so a batch of users resolves in ONE round-trip
 * (users + both file aliases + federation instance + roles) instead of
 * three. Postgres returns the aggregate as a JSON array of ints; an
 * absent row set yields `[]` via COALESCE.
 */
const roleIdsAggregate = sql<number[]>`
  COALESCE(
    (SELECT json_agg(${userRoles.roleId}) FROM ${userRoles}
      WHERE ${userRoles.userId} = ${users.id}),
    '[]'::json
  )
`.as('role_ids');

const selectPublicUsers = (userIds: number[]) => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  return db
    .select({
      id: users.id,
      name: users.name,
      publicId: users.publicId,
      federatedPublicId: users.federatedPublicId,
      supabaseId: users.supabaseId,
      bannerColor: users.bannerColor,
      bio: users.bio,
      customStatus: users.customStatus,
      deletedAt: users.deletedAt,
      customStatusEmoji: users.customStatusEmoji,
      customStatusExpiresAt: users.customStatusExpiresAt,
      pronouns: users.pronouns,
      nameplate: users.nameplate,
      avatarDecoration: users.avatarDecoration,
      nameStyle: users.nameStyle,
      banned: users.banned,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt,
      isFederated: users.isFederated,
      instanceDomain: federationInstances.domain,
      roleIds: roleIdsAggregate
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .leftJoin(
      federationInstances,
      eq(users.federatedInstanceId, federationInstances.id)
    )
    .where(inArray(users.id, userIds));
};

type TPublicUserRow = Awaited<ReturnType<typeof selectPublicUsers>>[number];

const toPublicUser = (row: TPublicUserRow): TJoinedPublicUser => ({
  id: row.id,
  name: row.name,
  publicId: row.publicId,
  federatedPublicId: row.federatedPublicId,
  bannerColor: row.bannerColor,
  bio: row.bio,
  ...statusTrio(row),
  nameplate: row.nameplate,
  avatarDecoration: row.avatarDecoration,
  nameStyle: row.nameStyle,
  avatarId: row.avatarId,
  bannerId: row.bannerId,
  avatar: slimFile(row.avatar),
  banner: slimFile(row.banner),
  createdAt: row.createdAt,
  banned: row.banned,
  deletedAt: row.deletedAt,
  _identity:
    row.isFederated && row.instanceDomain
      ? `${row.name}@${row.instanceDomain}`
      : undefined,
  roleIds: Array.isArray(row.roleIds) ? row.roleIds : [],
  // Labelled, not hidden: the account is a real member of the servers
  // its plugin posts in, and the roster should say what it is.
  ...(isPluginActorAuthId(row.supabaseId) ? { system: true } : {})
});

/**
 * Public projection of many users in ONE statement. Every list view
 * (friends, pending requests, blocked users, message authors) goes
 * through here so the query count never scales with the list length.
 */
const getPublicUsersByIds = async (
  userIds: number[]
): Promise<Map<number, TJoinedPublicUser>> => {
  const result = new Map<number, TJoinedPublicUser>();
  if (userIds.length === 0) return result;

  const rows = await selectPublicUsers([...new Set(userIds)]);

  for (const row of rows) {
    result.set(row.id, toPublicUser(row));
  }

  return result;
};

const getPublicUserById = async (
  userId: number
): Promise<TJoinedPublicUser | undefined> =>
  (await getPublicUsersByIds([userId])).get(userId);

const getStorageUsageByUserId = async (
  userId: number
): Promise<TStorageData> => {
  const [result] = await db
    .select({
      fileCount: count(files.id),
      usedStorage: sum(files.size)
    })
    .from(files)
    .where(eq(files.userId, userId))
    .limit(1);

  return {
    userId,
    fileCount: result?.fileCount ?? 0,
    usedStorage: Number(result?.usedStorage ?? 0)
  };
};

const getUserById = async (
  userId: number
): Promise<TJoinedUser | undefined> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const [user] = await db
    .select({
      id: users.id,
      supabaseId: users.supabaseId,
      name: users.name,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      bio: users.bio,
      customStatus: users.customStatus,
      deletedAt: users.deletedAt,
      customStatusEmoji: users.customStatusEmoji,
      customStatusExpiresAt: users.customStatusExpiresAt,
      pronouns: users.pronouns,
      nameplate: users.nameplate,
      avatarDecoration: users.avatarDecoration,
      nameStyle: users.nameStyle,
      gamePresence: users.gamePresence,
      bannerColor: users.bannerColor,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      lastLoginAt: users.lastLoginAt,
      banned: users.banned,
      banReason: users.banReason,
      bannedAt: users.bannedAt,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedUsername: users.federatedUsername,
      publicId: users.publicId,
      federatedPublicId: users.federatedPublicId,
      avatar: avatarFiles,
      banner: bannerFiles
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) return undefined;

  const roles = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));

  return {
    ...user,
    avatar: slimFile(user.avatar),
    banner: slimFile(user.banner),
    roleIds: roles.map((r) => r.roleId)
  };
};

const getUserBySupabaseId = async (
  supabaseId: string
): Promise<TJoinedUser | undefined> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const [user] = await db
    .select({
      id: users.id,
      supabaseId: users.supabaseId,
      name: users.name,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      bio: users.bio,
      customStatus: users.customStatus,
      deletedAt: users.deletedAt,
      customStatusEmoji: users.customStatusEmoji,
      customStatusExpiresAt: users.customStatusExpiresAt,
      pronouns: users.pronouns,
      nameplate: users.nameplate,
      avatarDecoration: users.avatarDecoration,
      nameStyle: users.nameStyle,
      gamePresence: users.gamePresence,
      bannerColor: users.bannerColor,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
      lastLoginAt: users.lastLoginAt,
      banned: users.banned,
      banReason: users.banReason,
      bannedAt: users.bannedAt,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedUsername: users.federatedUsername,
      publicId: users.publicId,
      federatedPublicId: users.federatedPublicId,
      avatar: avatarFiles,
      banner: bannerFiles
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(users.supabaseId, supabaseId))
    .limit(1);

  if (!user) return undefined;

  const roles = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, user.id));

  return {
    ...user,
    avatar: slimFile(user.avatar),
    banner: slimFile(user.banner),
    roleIds: roles.map((r) => r.roleId)
  };
};

/**
 * Resolve the auth-side identity for a session token, transparently
 * handling both the configured auth backend's tokens AND PULSE's own
 * self-contained OIDC session tokens. Returns the auth-side id (which maps
 * to `users.supabaseId`) plus whatever the backend knows about the user.
 *
 * OIDC tokens are checked first via a cheap unverified issuer peek so we
 * don't pay an authBackend round-trip (a network call in supabase mode)
 * for a token that's clearly ours; the signature is still verified.
 */
const resolveTokenIdentity = async (
  token: string
): Promise<{
  id: string;
  email: string | null;
  metadata?: Record<string, unknown>;
} | null> => {
  if (looksLikeOidcSession(token)) {
    const supabaseId = await verifySessionToken(token);
    return supabaseId ? { id: supabaseId, email: null } : null;
  }

  const { data, error } = await authBackend.getUser(token);
  if (error || !data.user) return null;
  return { id: data.user.id, email: data.user.email, metadata: data.user.metadata };
};

const getUserByToken = async (token: string | undefined) => {
  try {
    if (!token) return undefined;

    const identity = await resolveTokenIdentity(token);

    if (!identity) return undefined;

    const user = await getUserBySupabaseId(identity.id);

    return user;
  } catch {
    return undefined;
  }
};

const getUsers = async (serverId?: number): Promise<TJoinedUser[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const selection = {
    id: users.id,
    name: users.name,
    bannerColor: users.bannerColor,
    bio: users.bio,
      customStatus: users.customStatus,
      deletedAt: users.deletedAt,
      customStatusEmoji: users.customStatusEmoji,
      customStatusExpiresAt: users.customStatusExpiresAt,
      pronouns: users.pronouns,
      nameplate: users.nameplate,
      avatarDecoration: users.avatarDecoration,
      nameStyle: users.nameStyle,
      gamePresence: users.gamePresence,
    avatarId: users.avatarId,
    bannerId: users.bannerId,
    updatedAt: users.updatedAt,
    createdAt: users.createdAt,
    supabaseId: users.supabaseId,
    lastLoginAt: users.lastLoginAt,
    banned: users.banned,
    banReason: users.banReason,
    bannedAt: users.bannedAt,
    isFederated: users.isFederated,
    federatedInstanceId: users.federatedInstanceId,
    federatedUsername: users.federatedUsername,
    publicId: users.publicId,
    federatedPublicId: users.federatedPublicId,
    avatar: avatarFiles,
    banner: bannerFiles
  };

  const results = serverId
    ? await db
        .select(selection)
        .from(users)
        .innerJoin(serverMembers, eq(users.id, serverMembers.userId))
        .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
        .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
        .where(eq(serverMembers.serverId, serverId))
    : await db
        .select(selection)
        .from(users)
        .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
        .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id));

  // Get role IDs for all users
  const rolesByUser = await db
    .select({
      userId: userRoles.userId,
      roleId: userRoles.roleId
    })
    .from(userRoles);

  const rolesMap = rolesByUser.reduce(
    (acc, { userId, roleId }) => {
      if (!acc[userId]) acc[userId] = [];
      acc[userId].push(roleId);
      return acc;
    },
    {} as Record<number, number[]>
  );

  return results.map((result) => ({
    id: result.id,
    name: result.name,
    bannerColor: result.bannerColor,
    bio: result.bio,
    pronouns: result.pronouns,
    nameplate: result.nameplate,
    avatarDecoration: result.avatarDecoration,
    nameStyle: result.nameStyle,
    gamePresence: result.gamePresence,
    customStatus: result.customStatus,
    deletedAt: result.deletedAt,
    customStatusEmoji: result.customStatusEmoji,
    customStatusExpiresAt: result.customStatusExpiresAt,
    avatarId: result.avatarId,
    bannerId: result.bannerId,
    avatar: slimFile(result.avatar),
    banner: slimFile(result.banner),
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    supabaseId: result.supabaseId,
    lastLoginAt: result.lastLoginAt,
    banned: result.banned,
    banReason: result.banReason,
    bannedAt: result.bannedAt,
    isFederated: result.isFederated,
    federatedInstanceId: result.federatedInstanceId,
    federatedUsername: result.federatedUsername,
    publicId: result.publicId,
    federatedPublicId: result.federatedPublicId,
    roleIds: rolesMap[result.id] || []
  }));
};

/**
 * A server member as the member list shows them: the public projection
 * plus the per-membership fields (nickname, automod timeout deadline).
 */
type TServerMemberPublicUser = TJoinedPublicUser & {
  timedOutUntil: number | null;
};

const getPublicUsersForServer = async (
  serverId: number
): Promise<TServerMemberPublicUser[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const results = await db
    .select({
      id: users.id,
      name: users.name,
      publicId: users.publicId,
      bannerColor: users.bannerColor,
      bio: users.bio,
      customStatus: users.customStatus,
      deletedAt: users.deletedAt,
      customStatusEmoji: users.customStatusEmoji,
      customStatusExpiresAt: users.customStatusExpiresAt,
      pronouns: users.pronouns,
      nameplate: users.nameplate,
      avatarDecoration: users.avatarDecoration,
      nameStyle: users.nameStyle,
      banned: users.banned,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt,
      _identity: sql<string | null>`NULL`.as('_identity'),
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedPublicId: users.federatedPublicId,
      nickname: serverMembers.nickname,
      timedOutUntil: serverMembers.timedOutUntil
    })
    .from(users)
    .innerJoin(serverMembers, eq(users.id, serverMembers.userId))
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(serverMembers.serverId, serverId));

  // Scope userRoles to this server's roles only (avoids leaking role IDs from other servers)
  const rolesByUser = await db
    .select({
      userId: userRoles.userId,
      roleId: userRoles.roleId
    })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(roles.serverId, serverId));

  const rolesMap = rolesByUser.reduce(
    (acc, { userId, roleId }) => {
      if (!acc[userId]) acc[userId] = [];
      acc[userId].push(roleId);
      return acc;
    },
    {} as Record<number, number[]>
  );

  // Get federation instance domains for federated users
  const federatedInstanceIds = [
    ...new Set(
      results
        .filter((r) => r.isFederated && r.federatedInstanceId)
        .map((r) => r.federatedInstanceId!)
    )
  ];

  const instanceDomainMap: Record<number, string> = {};
  if (federatedInstanceIds.length > 0) {
    const instances = await db
      .select({ id: federationInstances.id, domain: federationInstances.domain })
      .from(federationInstances);
    for (const inst of instances) {
      instanceDomainMap[inst.id] = inst.domain;
    }
  }

  return results.map((result) => {
    let identity: string | undefined;

    // For federated users, set _identity to username@domain
    if (result.isFederated && result.federatedInstanceId) {
      const domain = instanceDomainMap[result.federatedInstanceId];
      if (domain) {
        identity = `${result.name}@${domain}`;
      }
    }

    return {
      id: result.id,
      name: result.name,
      publicId: result.publicId,
      federatedPublicId: result.federatedPublicId,
      bannerColor: result.bannerColor,
      bio: result.bio,
      ...statusTrio(result),
      nameplate: result.nameplate,
      avatarDecoration: result.avatarDecoration,
      nameStyle: result.nameStyle,
      banned: result.banned,
      deletedAt: result.deletedAt,
      avatarId: result.avatarId,
      bannerId: result.bannerId,
      avatar: slimFile(result.avatar),
      banner: slimFile(result.banner),
      createdAt: result.createdAt,
      _identity: identity,
      roleIds: rolesMap[result.id] || [],
      nickname: result.nickname,
      timedOutUntil: result.timedOutUntil
    };
  });
};

const isDisplayNameTaken = async (
  name: string,
  excludeUserId?: number
): Promise<boolean> => {
  const [result] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.name, name))
    .limit(1);

  if (!result) return false;
  if (excludeUserId && result.id === excludeUserId) return false;

  return true;
};

export type { TServerMemberPublicUser };
export {
  getPublicUserById,
  getPublicUsersByIds,
  getPublicUsersForServer,
  getStorageUsageByUserId,
  getUserById,
  getUserBySupabaseId,
  getUserByToken,
  getUsers,
  isDisplayNameTaken,
  resolveTokenIdentity
};
