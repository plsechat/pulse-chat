import type { TFile, TFileRef, TJoinedInvite } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db } from '..';
import { files, invites, userRoles, users } from '../schema';

const slimFile = (file: TFile | null): TFileRef | null =>
  file ? { id: file.id, name: file.name } : null;

const isInviteValid = async (
  code: string | undefined
): Promise<string | undefined> => {
  if (!code) {
    return 'Invalid invite code';
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, code))
    .limit(1);

  if (!invite) {
    return 'Invite code not found';
  }

  if (invite.expiresAt && invite.expiresAt < Date.now()) {
    return 'Invite code has expired';
  }

  if (invite.maxUses && invite.uses >= invite.maxUses) {
    return 'Invite code has reached maximum uses';
  }

  return undefined;
};

const getInvites = async (serverId?: number): Promise<TJoinedInvite[]> => {
  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  let query = db
    .select({
      invite: invites,
      creator: {
        id: users.id,
        name: users.name,
        publicId: users.publicId,
        bannerColor: users.bannerColor,
        bio: users.bio,
        banned: users.banned,
        createdAt: users.createdAt,
        avatarId: users.avatarId,
        bannerId: users.bannerId
      },
      avatar: avatarFiles,
      banner: bannerFiles
    })
    .from(invites)
    .innerJoin(users, eq(invites.creatorId, users.id))
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id));

  if (serverId !== undefined) {
    query = query.where(eq(invites.serverId, serverId)) as typeof query;
  }

  const rows = await query;

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

  return rows.map((row) => ({
    ...row.invite,
    creator: {
      ...row.creator,
      avatar: slimFile(row.avatar),
      banner: slimFile(row.banner),
      roleIds: rolesMap[row.creator.id] || []
    }
  }));
};

export { getInvites, isInviteValid };
