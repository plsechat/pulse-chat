import {
  type TJoinedPublicUser,
  type TJoinedUser,
  type TStorageData
} from '@pulse/shared';
import { count, eq, inArray, sum } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '..';
import { supabaseAdmin } from '../../utils/supabase';
import { federationInstances, files, serverMembers, userRoles, users } from '../schema';

const getPublicUserById = async (
  userId: number
): Promise<TJoinedPublicUser | undefined> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const [results] = await db
    .select({
      id: users.id,
      name: users.name,
      publicId: users.publicId,
      bannerColor: users.bannerColor,
      bio: users.bio,
      banned: users.banned,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(users.id, userId))
    .limit(1);

  if (!results) return undefined;

  const roles = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));

  // Resolve federation identity
  let identity: string | undefined;
  if (results.isFederated && results.federatedInstanceId) {
    const [instance] = await db
      .select({ domain: federationInstances.domain })
      .from(federationInstances)
      .where(eq(federationInstances.id, results.federatedInstanceId))
      .limit(1);
    if (instance) {
      identity = `${results.name}@${instance.domain}`;
    }
  }

  return {
    id: results.id,
    name: results.name,
    publicId: results.publicId,
    bannerColor: results.bannerColor,
    bio: results.bio,
    avatarId: results.avatarId,
    bannerId: results.bannerId,
    avatar: results.avatar,
    banner: results.banner,
    createdAt: results.createdAt,
    banned: results.banned,
    _identity: identity,
    roleIds: roles.map((r) => r.roleId)
  };
};

const getPublicUsersByIds = async (
  userIds: number[]
): Promise<Map<number, TJoinedPublicUser>> => {
  const result = new Map<number, TJoinedPublicUser>();
  if (userIds.length === 0) return result;

  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      publicId: users.publicId,
      bannerColor: users.bannerColor,
      bio: users.bio,
      banned: users.banned,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(inArray(users.id, userIds));

  if (rows.length === 0) return result;

  // Batch-fetch roles for all users
  const roleRows = await db
    .select({ userId: userRoles.userId, roleId: userRoles.roleId })
    .from(userRoles)
    .where(inArray(userRoles.userId, userIds));

  const rolesMap: Record<number, number[]> = {};
  for (const r of roleRows) {
    if (!rolesMap[r.userId]) rolesMap[r.userId] = [];
    rolesMap[r.userId]!.push(r.roleId);
  }

  // Batch-fetch federation instances if any federated users
  const federatedInstanceIds = [
    ...new Set(
      rows
        .filter((r) => r.isFederated && r.federatedInstanceId)
        .map((r) => r.federatedInstanceId!)
    )
  ];

  const instanceDomainMap: Record<number, string> = {};
  if (federatedInstanceIds.length > 0) {
    const instances = await db
      .select({ id: federationInstances.id, domain: federationInstances.domain })
      .from(federationInstances)
      .where(inArray(federationInstances.id, federatedInstanceIds));
    for (const inst of instances) {
      instanceDomainMap[inst.id] = inst.domain;
    }
  }

  for (const row of rows) {
    let identity: string | undefined;
    if (row.isFederated && row.federatedInstanceId) {
      const domain = instanceDomainMap[row.federatedInstanceId];
      if (domain) identity = `${row.name}@${domain}`;
    }

    result.set(row.id, {
      id: row.id,
      name: row.name,
      publicId: row.publicId,
      bannerColor: row.bannerColor,
      bio: row.bio,
      avatarId: row.avatarId,
      bannerId: row.bannerId,
      avatar: row.avatar,
      banner: row.banner,
      createdAt: row.createdAt,
      banned: row.banned,
      _identity: identity,
      roleIds: rolesMap[row.id] || []
    });
  }

  return result;
};

const getPublicUsers = async (
  returnIdentity: boolean = false
): Promise<TJoinedPublicUser[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  if (returnIdentity) {
    const results = await db
      .select({
        id: users.id,
        name: users.name,
        publicId: users.publicId,
        bannerColor: users.bannerColor,
        bio: users.bio,
        banned: users.banned,
        avatarId: users.avatarId,
        bannerId: users.bannerId,
        avatar: avatarFiles,
        banner: bannerFiles,
        createdAt: users.createdAt,
        _identity: users.supabaseId
      })
      .from(users)
      .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
      .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id));

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
      publicId: result.publicId,
      bannerColor: result.bannerColor,
      bio: result.bio,
      banned: result.banned,
      avatarId: result.avatarId,
      bannerId: result.bannerId,
      avatar: result.avatar,
      banner: result.banner,
      createdAt: result.createdAt,
      _identity: result._identity,
      roleIds: rolesMap[result.id] || []
    }));
  } else {
    const results = await db
      .select({
        id: users.id,
        name: users.name,
        publicId: users.publicId,
        banned: users.banned,
        bannerColor: users.bannerColor,
        bio: users.bio,
        avatarId: users.avatarId,
        bannerId: users.bannerId,
        avatar: avatarFiles,
        banner: bannerFiles,
        createdAt: users.createdAt
      })
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
      publicId: result.publicId,
      banned: result.banned,
      bannerColor: result.bannerColor,
      bio: result.bio,
      avatarId: result.avatarId,
      bannerId: result.bannerId,
      avatar: result.avatar,
      banner: result.banner,
      createdAt: result.createdAt,
      roleIds: rolesMap[result.id] || []
    }));
  }
};

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
    avatar: user.avatar,
    banner: user.banner,
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
    avatar: user.avatar,
    banner: user.banner,
    roleIds: roles.map((r) => r.roleId)
  };
};

const getUserByToken = async (token: string | undefined) => {
  try {
    if (!token) return undefined;

    const {
      data: { user: supabaseUser },
      error
    } = await supabaseAdmin.auth.getUser(token);

    if (error || !supabaseUser) return undefined;

    const user = await getUserBySupabaseId(supabaseUser.id);

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
    avatarId: result.avatarId,
    bannerId: result.bannerId,
    avatar: result.avatar,
    banner: result.banner,
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

const getPublicUsersForServer = async (
  serverId: number
): Promise<TJoinedPublicUser[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const results = await db
    .select({
      id: users.id,
      name: users.name,
      publicId: users.publicId,
      bannerColor: users.bannerColor,
      bio: users.bio,
      banned: users.banned,
      avatarId: users.avatarId,
      bannerId: users.bannerId,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt,
      _identity: users.supabaseId,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      nickname: serverMembers.nickname
    })
    .from(users)
    .innerJoin(serverMembers, eq(users.id, serverMembers.userId))
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(eq(serverMembers.serverId, serverId));

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
    let identity = result._identity;

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
      bannerColor: result.bannerColor,
      bio: result.bio,
      banned: result.banned,
      avatarId: result.avatarId,
      bannerId: result.bannerId,
      avatar: result.avatar,
      banner: result.banner,
      createdAt: result.createdAt,
      _identity: identity,
      roleIds: rolesMap[result.id] || [],
      nickname: result.nickname
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

export {
  getPublicUserById,
  getPublicUsersByIds,
  getPublicUsers,
  getPublicUsersForServer,
  getStorageUsageByUserId,
  getUserById,
  getUserBySupabaseId,
  getUserByToken,
  getUsers,
  isDisplayNameTaken
};
