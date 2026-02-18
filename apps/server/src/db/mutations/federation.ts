import type { TUser } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq } from 'drizzle-orm';
import path from 'path';
import { db } from '..';
import { PUBLIC_PATH } from '../../helpers/paths';
import { logger } from '../../logger';
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

export {
  deleteShadowUsersByInstance,
  findOrCreateShadowUser,
  getShadowUsersByInstance,
  syncShadowUserAvatar
};
