import type { TUser } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq } from 'drizzle-orm';
import path from 'path';
import { db } from '..';
import { PUBLIC_PATH } from '../../helpers/paths';
import { logger } from '../../logger';
import { config } from '../../config';
import { signChallenge } from '../../utils/federation';
import { federationFetch } from '../../utils/federation-fetch';
import { fetchBoundedImage } from '../../utils/fetch-bounded-image';
import { validateFederationUrl } from '../../utils/validate-url';
import { publishUser } from '../publishers';
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
      logger.debug(
        '[shadowUser] hit variant=byPublicId instanceId=%d remotePublicId=%s userId=%d',
        instanceId,
        remotePublicId,
        byPublicId.id
      );
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
    logger.debug(
      '[shadowUser] hit variant=byUsername instanceId=%d remoteUserId=%s userId=%d',
      instanceId,
      remoteUserId,
      existing.id
    );
    return existing;
  }

  // Create shadow user with synthetic supabaseId (use onConflictDoNothing to handle races)
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
    .onConflictDoNothing()
    .returning();

  if (shadowUser) {
    logger.debug(
      '[shadowUser] created variant=byUsername instanceId=%d remoteUserId=%s userId=%d',
      instanceId,
      remoteUserId,
      shadowUser.id
    );
    return shadowUser;
  }

  // Conflict: another request already created this user — re-query
  const [raced] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.federatedInstanceId, instanceId),
        eq(users.federatedUsername, String(remoteUserId))
      )
    )
    .limit(1);

  return raced!;
}

/**
 * Phase D / D2 — find-or-create a shadow user identified ONLY by
 * (federatedInstanceId, federatedPublicId). Unlike `findOrCreateShadowUser`,
 * does NOT fall back to looking up by `federatedUsername`. Used by the
 * group-DM federation handlers which don't receive per-member remote
 * user ids over the wire — only publicIds.
 *
 * The fallback path in `findOrCreateShadowUser` causes false positives
 * when multiple shadows on the same instance are inserted with the
 * same sentinel `federatedUsername='0'`: the second lookup matches
 * the first row and returns it as if it were the new member.
 */
async function findOrCreateShadowUserByPublicId(
  instanceId: number,
  remotePublicId: string,
  name: string
): Promise<TUser> {
  const [existing] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.federatedInstanceId, instanceId),
        eq(users.federatedPublicId, remotePublicId)
      )
    )
    .limit(1);

  if (existing) {
    if (existing.name !== name) {
      await db
        .update(users)
        .set({ name, updatedAt: Date.now() })
        .where(eq(users.id, existing.id));
    }
    logger.debug(
      '[shadowUser] hit variant=byPublicId-only instanceId=%d remotePublicId=%s userId=%d',
      instanceId,
      remotePublicId,
      existing.id
    );
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({
      supabaseId: `federated-${randomUUIDv7()}`,
      name,
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId: remotePublicId,
      // federatedUsername left NULL — we don't know the remote user id
      // from the group-DM federation messages.
      publicId: randomUUIDv7(),
      createdAt: Date.now(),
      lastLoginAt: Date.now()
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    logger.debug(
      '[shadowUser] created variant=byPublicId-only instanceId=%d remotePublicId=%s userId=%d',
      instanceId,
      remotePublicId,
      created.id
    );
    return created;
  }

  // Race: another concurrent caller inserted the same shadow first.
  const [raced] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.federatedInstanceId, instanceId),
        eq(users.federatedPublicId, remotePublicId)
      )
    )
    .limit(1);

  return raced!;
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

// Caps for federated media proxies (Phase 4 / F3). Federated peers
// can serve arbitrarily large bytes; we don't blindly accept what
// they hand us, especially for proxied avatars/banners that go to
// disk under our PUBLIC_PATH. 10 MB is plenty for any realistic
// avatar/banner (Discord caps avatars at 8 MB animated, 10 MB total).
const MAX_FEDERATED_AVATAR_BYTES = 10 * 1024 * 1024;

async function syncShadowUserAvatar(
  shadowUserId: number,
  remoteAvatarUrl: string
): Promise<void> {
  try {
    // Validate URL is safe (not internal/private IP)
    const validatedUrl = await validateFederationUrl(remoteAvatarUrl);

    // Skip if shadow already has an avatar
    const [shadow] = await db
      .select({ avatarId: users.avatarId })
      .from(users)
      .where(eq(users.id, shadowUserId))
      .limit(1);

    if (shadow?.avatarId) return;

    // F3 + F4: stream-bounded fetch with magic-byte sniff. Rejects
    // oversized bodies before they hit disk and forces the saved
    // mime/extension to whatever the bytes actually are, never the
    // attacker-controlled Content-Type header.
    const sniffed = await fetchBoundedImage(
      validatedUrl.href,
      MAX_FEDERATED_AVATAR_BYTES,
      { signal: AbortSignal.timeout(10_000) }
    );

    const fileName = `federated-avatar-${randomUUIDv7()}${sniffed.extension}`;
    const filePath = path.join(PUBLIC_PATH, fileName);

    await Bun.write(filePath, sniffed.bytes);

    const [fileRecord] = await db
      .insert(files)
      .values({
        name: fileName,
        originalName: fileName,
        md5: `federated-${randomUUIDv7()}`,
        userId: shadowUserId,
        size: sniffed.bytes.byteLength,
        mimeType: sniffed.mimeType,
        extension: sniffed.extension,
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
  const validatedUrl = await validateFederationUrl(remoteUrl);

  // Same cap as avatars — every call site is image-only (avatar /
  // banner) so 10 MB is safely generous and small enough to bound
  // disk damage from a hostile peer.
  let sniffed;
  try {
    sniffed = await fetchBoundedImage(
      validatedUrl.href,
      MAX_FEDERATED_AVATAR_BYTES,
      { signal: AbortSignal.timeout(10_000) }
    );
  } catch (err) {
    logger.warn(
      '[downloadFederatedFile] failed for url=%s: %o',
      remoteUrl,
      err
    );
    return null;
  }

  const fileName = `${prefix}-${randomUUIDv7()}${sniffed.extension}`;
  const filePath = path.join(PUBLIC_PATH, fileName);
  await Bun.write(filePath, sniffed.bytes);

  const [fileRecord] = await db
    .insert(files)
    .values({
      name: fileName,
      originalName: remoteOriginalName,
      md5: `federated-${randomUUIDv7()}`,
      userId,
      size: sniffed.bytes.byteLength,
      mimeType: sniffed.mimeType,
      extension: sniffed.extension,
      createdAt: Date.now()
    })
    .returning();

  if (!fileRecord) {
    logger.debug('[downloadFederatedFile] insert returned no row prefix=%s', prefix);
    return null;
  }
  logger.debug(
    '[downloadFederatedFile] saved prefix=%s userId=%d fileId=%d size=%d',
    prefix,
    userId,
    fileRecord.id,
    sniffed.bytes.byteLength
  );
  return { fileId: fileRecord.id, fileName };
}

async function syncShadowUserProfile(
  shadowUserId: number,
  issuerDomain: string,
  publicId: string,
  opts?: { force?: boolean }
): Promise<void> {
  try {
    // Debounce: skip if recently synced — unless `force` is set,
    // which the user-info-update push path uses to bypass debounce
    // when the home instance has explicitly told us a profile field
    // changed.
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

    if (!shadow) {
      logger.debug('[shadowProfile] skipped (no shadow row) userId=%d', shadowUserId);
      return;
    }

    if (
      !opts?.force &&
      shadow.updatedAt &&
      Date.now() - shadow.updatedAt < PROFILE_SYNC_DEBOUNCE_MS
    ) {
      logger.debug(
        '[shadowProfile] debounced userId=%d sinceMs=%d',
        shadowUserId,
        Date.now() - shadow.updatedAt
      );
      return;
    }
    logger.debug(
      '[shadowProfile] syncing userId=%d issuer=%s force=%s',
      shadowUserId,
      issuerDomain,
      opts?.force ?? false
    );

    // Fetch profile from home instance
    const protocol = issuerDomain.includes('localhost') ? 'http' : 'https';
    const bodyToSign = {
      publicId,
      fromDomain: config.federation.domain
    };
    const signature = await signChallenge(bodyToSign, issuerDomain);

    const infoResponse = await federationFetch(
      `${protocol}://${issuerDomain}/federation/user-info`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...bodyToSign,
          signature
        }),
        signal: AbortSignal.timeout(10_000)
      }
    );

    if (!infoResponse.ok) return;

    const profile = (await infoResponse.json()) as {
      name: string;
      bio: string | null;
      bannerColor: string | null;
      avatar: { name: string } | null;
      banner: { name: string } | null;
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
      logger.debug(
        '[shadowProfile] applied userId=%d fields=%o',
        shadowUserId,
        Object.keys(updates).filter((k) => k !== 'updatedAt')
      );

      // Notify connected clients about the profile change
      publishUser(shadowUserId, 'update');
    } else {
      logger.debug('[shadowProfile] no-op userId=%d (no changed fields)', shadowUserId);
    }
  } catch (err) {
    logger.error('[syncShadowUserProfile] failed for user %d: %o', shadowUserId, err);
  }
}

export {
  deleteShadowUsersByInstance,
  findOrCreateShadowUser,
  findOrCreateShadowUserByPublicId,
  getShadowUsersByInstance,
  syncShadowUserAvatar,
  syncShadowUserProfile
};
