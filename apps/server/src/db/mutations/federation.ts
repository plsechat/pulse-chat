import type { TFile, TUser } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq } from 'drizzle-orm';
import path from 'path';
import { db } from '..';
import { PUBLIC_PATH } from '../../helpers/paths';
import { logger } from '../../logger';
import { signChallenge } from '../../utils/federation';
import { validateFederationUrl } from '../../utils/validate-url';
import { files, users } from '../schema';

async function findOrCreateShadowUser(
  instanceId: number,
  remoteUserId: number,
  username: string,
  _avatar?: string | null,
  remotePublicId?: string
): Promise<TUser> {
  // Primary lookup: by federatedPublicId (immutable UUID — most reliable)
  if (remotePublicId) {
    const [byPublicId] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.federatedInstanceId, instanceId),
          eq(users.federatedPublicId, remotePublicId)
        )
      )
      .limit(1);

    if (byPublicId) {
      // Sync display name and legacy federatedUsername if changed
      const updates: Record<string, unknown> = {};
      if (byPublicId.name !== username) {
        updates.name = username;
      }
      if (byPublicId.federatedUsername !== String(remoteUserId) && remoteUserId !== 0) {
        updates.federatedUsername = String(remoteUserId);
      }
      if (Object.keys(updates).length > 0) {
        updates.updatedAt = Date.now();
        await db.update(users).set(updates).where(eq(users.id, byPublicId.id));
      }
      return byPublicId;
    }
  }

  // Fallback lookup: by legacy federatedUsername (numeric remote ID)
  const [existing] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.federatedInstanceId, instanceId),
        eq(users.federatedUsername, String(remoteUserId))
      )
    )
    .limit(1);

  if (existing) {
    // Update name if changed, and backfill federatedPublicId
    const updates: Record<string, unknown> = {};
    if (existing.name !== username) {
      updates.name = username;
    }
    if (remotePublicId && !existing.federatedPublicId) {
      updates.federatedPublicId = remotePublicId;
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = Date.now();
      await db.update(users).set(updates).where(eq(users.id, existing.id));
    }
    return existing;
  }

  // Create shadow user with synthetic supabaseId
  const [shadowUser] = await db
    .insert(users)
    .values({
      supabaseId: `federated:${instanceId}:${remoteUserId}`,
      name: username,
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedUsername: String(remoteUserId),
      publicId: randomUUIDv7(),
      federatedPublicId: remotePublicId || null,
      createdAt: Date.now(),
      lastLoginAt: Date.now()
    })
    .returning();

  return shadowUser!;
}

async function deleteShadowUsersByInstance(instanceId: number): Promise<void> {
  await db
    .delete(users)
    .where(
      and(
        eq(users.isFederated, true),
        eq(users.federatedInstanceId, instanceId)
      )
    );
}

async function getShadowUsersByInstance(
  instanceId: number
): Promise<TUser[]> {
  return db
    .select()
    .from(users)
    .where(
      and(
        eq(users.isFederated, true),
        eq(users.federatedInstanceId, instanceId)
      )
    );
}

async function syncShadowUserAvatar(
  shadowUserId: number,
  remoteAvatarUrl: string
): Promise<void> {
  try {
    // Validate URL is safe (not internal/private IP)
    await validateFederationUrl(remoteAvatarUrl);

    // Skip if shadow already has an avatar
    const [shadow] = await db
      .select({ avatarId: users.avatarId })
      .from(users)
      .where(eq(users.id, shadowUserId))
      .limit(1);

    if (shadow?.avatarId) return;

    const response = await fetch(remoteAvatarUrl, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) return;

    const buffer = await response.arrayBuffer();
    const contentType =
      response.headers.get('content-type') || 'image/png';
    const ext = contentType.includes('png')
      ? '.png'
      : contentType.includes('gif')
        ? '.gif'
        : contentType.includes('webp')
          ? '.webp'
          : '.jpg';
    const fileName = `federated-avatar-${randomUUIDv7()}${ext}`;
    const filePath = path.join(PUBLIC_PATH, fileName);

    await Bun.write(filePath, buffer);

    const [fileRecord] = await db
      .insert(files)
      .values({
        name: fileName,
        originalName: fileName,
        md5: `federated-${randomUUIDv7()}`,
        userId: shadowUserId,
        size: buffer.byteLength,
        mimeType: contentType,
        extension: ext,
        createdAt: Date.now()
      })
      .returning();

    if (fileRecord) {
      await db
        .update(users)
        .set({ avatarId: fileRecord.id, updatedAt: Date.now() })
        .where(eq(users.id, shadowUserId));
    }
  } catch (err) {
    logger.error('[syncShadowUserAvatar] failed for user %d: %o', shadowUserId, err);
  }
}

const PROFILE_SYNC_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes

async function downloadFederatedFile(
  remoteUrl: string,
  prefix: string,
  userId: number,
  remoteOriginalName: string
): Promise<{ fileId: number; fileName: string } | null> {
  await validateFederationUrl(remoteUrl);

  const response = await fetch(remoteUrl, {
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) return null;

  const buffer = await response.arrayBuffer();
  const contentType = response.headers.get('content-type') || 'image/png';
  const ext = contentType.includes('png')
    ? '.png'
    : contentType.includes('gif')
      ? '.gif'
      : contentType.includes('webp')
        ? '.webp'
        : '.jpg';

  const fileName = `${prefix}-${randomUUIDv7()}${ext}`;
  const filePath = path.join(PUBLIC_PATH, fileName);
  await Bun.write(filePath, buffer);

  const [fileRecord] = await db
    .insert(files)
    .values({
      name: fileName,
      originalName: remoteOriginalName,
      md5: `federated-${randomUUIDv7()}`,
      userId,
      size: buffer.byteLength,
      mimeType: contentType,
      extension: ext,
      createdAt: Date.now()
    })
    .returning();

  if (!fileRecord) return null;
  return { fileId: fileRecord.id, fileName };
}

async function syncShadowUserProfile(
  shadowUserId: number,
  issuerDomain: string,
  publicId: string
): Promise<void> {
  try {
    // Debounce: skip if recently synced
    const [shadow] = await db
      .select({
        avatarId: users.avatarId,
        bannerId: users.bannerId,
        bio: users.bio,
        bannerColor: users.bannerColor,
        updatedAt: users.updatedAt
      })
      .from(users)
      .where(eq(users.id, shadowUserId))
      .limit(1);

    if (!shadow) return;

    if (shadow.updatedAt && Date.now() - shadow.updatedAt < PROFILE_SYNC_DEBOUNCE_MS) {
      return;
    }

    // Fetch profile from home instance
    const protocol = issuerDomain.includes('localhost') ? 'http' : 'https';
    const signature = await signChallenge(JSON.stringify({ publicId }));

    const infoResponse = await fetch(
      `${protocol}://${issuerDomain}/federation/user-info`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicId, signature }),
        signal: AbortSignal.timeout(10_000)
      }
    );

    if (!infoResponse.ok) return;

    const profile = (await infoResponse.json()) as {
      name: string;
      bio: string | null;
      bannerColor: string | null;
      avatar: TFile | null;
      banner: TFile | null;
      createdAt: number;
    };

    const updates: Record<string, unknown> = {};

    // Sync avatar
    if (profile.avatar?.name) {
      // Check if current avatar is different
      let currentAvatarName: string | null = null;
      if (shadow.avatarId) {
        const [currentFile] = await db
          .select({ originalName: files.originalName })
          .from(files)
          .where(eq(files.id, shadow.avatarId))
          .limit(1);
        currentAvatarName = currentFile?.originalName ?? null;
      }

      // Download if no avatar or remote file changed
      if (!shadow.avatarId || currentAvatarName !== profile.avatar.name) {
        const avatarUrl = `${protocol}://${issuerDomain}/public/${profile.avatar.name}`;
        const result = await downloadFederatedFile(avatarUrl, 'federated-avatar', shadowUserId, profile.avatar.name);
        if (result) {
          updates.avatarId = result.fileId;
        }
      }
    }

    // Sync banner
    if (profile.banner?.name) {
      let currentBannerName: string | null = null;
      if (shadow.bannerId) {
        const [currentFile] = await db
          .select({ originalName: files.originalName })
          .from(files)
          .where(eq(files.id, shadow.bannerId))
          .limit(1);
        currentBannerName = currentFile?.originalName ?? null;
      }

      if (!shadow.bannerId || currentBannerName !== profile.banner.name) {
        const bannerUrl = `${protocol}://${issuerDomain}/public/${profile.banner.name}`;
        const result = await downloadFederatedFile(bannerUrl, 'federated-banner', shadowUserId, profile.banner.name);
        if (result) {
          updates.bannerId = result.fileId;
        }
      }
    }

    // Sync bio and bannerColor
    if (profile.bio !== shadow.bio) {
      updates.bio = profile.bio;
    }
    if (profile.bannerColor !== shadow.bannerColor) {
      updates.bannerColor = profile.bannerColor;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = Date.now();
      await db.update(users).set(updates).where(eq(users.id, shadowUserId));
    }
  } catch (err) {
    logger.error('[syncShadowUserProfile] failed for user %d: %o', shadowUserId, err);
  }
}

export {
  deleteShadowUsersByInstance,
  findOrCreateShadowUser,
  getShadowUsersByInstance,
  syncShadowUserAvatar,
  syncShadowUserProfile
};
