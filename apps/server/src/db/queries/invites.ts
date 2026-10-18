import type { TFile, TFileRef, TJoinedInvite } from '../../types';
import { and, eq, gt, sql } from 'drizzle-orm';
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

/**
 * Atomically consume one use of an invite. The check (exists, not expired,
 * under maxUses) and the increment are ONE conditional UPDATE, so two
 * concurrent signups racing for the last use of a `maxUses` invite cannot
 * both pass — exactly one row comes back. Returns true when a use was
 * consumed; false when the invite is missing, expired or exhausted (call
 * `isInviteValid` afterwards for the human-readable reason).
 *
 * Every signup entry point (password register, login auto-register,
 * social provision, OIDC callback) must consume through here; a separate
 * `isInviteValid` + unconditional `uses + 1` is the TOCTOU this replaces.
 */
const consumeInvite = async (code: string | undefined): Promise<boolean> => {
  if (!code) return false;

  const result = await db
    .update(invites)
    .set({ uses: sql`${invites.uses} + 1` })
    .where(
      and(
        eq(invites.code, code),
        sql`(${invites.expiresAt} IS NULL OR ${invites.expiresAt} = 0 OR ${invites.expiresAt} > ${Date.now()})`,
        sql`(${invites.maxUses} IS NULL OR ${invites.maxUses} = 0 OR ${invites.uses} < ${invites.maxUses})`
      )
    )
    .returning({ code: invites.code });

  return result.length > 0;
};

/**
 * Give back a use consumed by `consumeInvite` when the signup it was
 * consumed for did not go through (auth-backend createUser failed, app
 * user insert failed). Keeps a single-use invite alive after a typo'd
 * registration instead of burning it. Never goes below zero.
 */
const releaseInvite = async (code: string | undefined): Promise<void> => {
  if (!code) return;

  await db
    .update(invites)
    .set({ uses: sql`${invites.uses} - 1` })
    .where(and(eq(invites.code, code), gt(invites.uses, 0)));
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
        pronouns: users.pronouns,
        nameplate: users.nameplate,
        avatarDecoration: users.avatarDecoration,
        nameStyle: users.nameStyle,
        customStatus: users.customStatus,
        deletedAt: users.deletedAt,
        customStatusEmoji: users.customStatusEmoji,
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

export { consumeInvite, getInvites, isInviteValid, releaseInvite };
