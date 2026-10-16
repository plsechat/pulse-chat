import { ServerEvents, type TUser } from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { and, eq, inArray } from 'drizzle-orm';
import path from 'path';
import { db } from '..';
import { PUBLIC_PATH } from '../../helpers/paths';
import { logger } from '../../logger';
import { config } from '../../config';
import { queryInstance, signChallenge } from '../../utils/federation';
import { federationFetch } from '../../utils/federation-fetch';
import { fetchBoundedImage } from '../../utils/fetch-bounded-image';
import { getFederationProtocol, validateFederationUrl } from '../../utils/validate-url';
import { pubsub } from '../../utils/pubsub';
import { publishUser } from '../publishers';
import { dmChannelMembers, dmChannels, federationInstances, files, users } from '../schema';

/**
 * A shadow's display name is a users.name like any other: cap it here
 * so every entry point (DM relay, friend request, group DM, descriptor
 * resolution) is covered, whatever the caller validated.
 */
const MAX_SHADOW_NAME_LENGTH = 32;
const MAX_SHADOW_BIO_LENGTH = 500;
const SHADOW_BANNER_COLOR_RE = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

const boundShadowName = (name: string): string =>
  name.slice(0, MAX_SHADOW_NAME_LENGTH);

/**
 * A shadow user is identified by its home instance and the publicId that
 * home issued — nothing else. The peer's numeric user id is stored in
 * `federatedUsername` for display/debugging only and is never looked up:
 * peers renumber, two peers' id-spaces overlap, and the inbound handlers
 * substitute 0 when a peer omits it, so a lookup by that value could hand
 * one remote user another user's shadow (name, DMs, roles included).
 *
 * `remoteUserId` is the informational numeric id; `0`/undefined means
 * "unknown" and leaves the stored value alone.
 */
async function findOrCreateShadowUserByPublicId(
  instanceId: number,
  remotePublicId: string,
  rawName: string,
  remoteUserId?: number
): Promise<TUser> {
  const name = boundShadowName(rawName);
  const informationalUsername =
    remoteUserId !== undefined && remoteUserId > 0 ? String(remoteUserId) : null;

  const findExisting = async (): Promise<TUser | undefined> => {
    const [row] = await db
      .select()
      .from(users)
      .where(
        and(
          eq(users.federatedInstanceId, instanceId),
          eq(users.federatedPublicId, remotePublicId)
        )
      )
      .limit(1);
    return row;
  };

  const existing = await findExisting();

  if (existing) {
    const updates: Partial<typeof users.$inferInsert> = {};
    // An empty name means "caller doesn't know it" (descriptor
    // resolution without a name) — never blank an existing shadow.
    if (name !== '' && existing.name !== name) {
      updates.name = name;
    }
    if (
      informationalUsername !== null &&
      existing.federatedUsername !== informationalUsername
    ) {
      updates.federatedUsername = informationalUsername;
    }
    if (Object.keys(updates).length > 0) {
      updates.updatedAt = Date.now();
      await db.update(users).set(updates).where(eq(users.id, existing.id));
    }
    logger.debug(
      '[shadowUser] hit instanceId=%d remotePublicId=%s userId=%d',
      instanceId,
      remotePublicId.replace(/[\r\n]/g, ''),
      existing.id
    );
    return { ...existing, ...updates };
  }

  // No conflict target: the (instance, publicId) identity index is what
  // we expect to collide on, but an operator database that still holds
  // pre-fix duplicate shadows boots without it (see migration 0036), and
  // the row's own publicId/supabaseId uniques must stay covered too.
  const [created] = await db
    .insert(users)
    .values({
      supabaseId: `federated-${randomUUIDv7()}`,
      // A nameless mint (descriptor resolution without a name) gets a
      // readable placeholder instead of an empty display name.
      name: name || remotePublicId.slice(0, MAX_SHADOW_NAME_LENGTH),
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId: remotePublicId,
      federatedUsername: informationalUsername,
      publicId: randomUUIDv7(),
      createdAt: Date.now(),
      lastLoginAt: Date.now()
    })
    .onConflictDoNothing()
    .returning();

  if (created) {
    logger.debug(
      '[shadowUser] created instanceId=%d remotePublicId=%s userId=%d',
      instanceId,
      remotePublicId.replace(/[\r\n]/g, ''),
      created.id
    );
    return created;
  }

  // Race: a concurrent caller inserted the same shadow first — the
  // identity index swallowed ours, so the re-select returns theirs.
  const raced = await findExisting();
  if (!raced) {
    throw new Error(
      `Shadow user insert for instance ${instanceId} conflicted but no row exists for the publicId`
    );
  }
  return raced;
}

/**
 * Call-site-compatible wrapper for the token/handler paths that still carry
 * the peer's numeric id alongside the publicId. The publicId is mandatory:
 * `verifyFederationToken` rejects tokens without one and every inbound
 * handler requires `fromPublicId`, so a missing value here is a caller
 * bug, not an older peer — refuse rather than mint an unidentifiable row.
 */
async function findOrCreateShadowUser(
  instanceId: number,
  remoteUserId: number,
  rawUsername: string,
  _avatar?: string | null,
  remotePublicId?: string
): Promise<TUser> {
  if (!remotePublicId) {
    logger.warn(
      '[shadowUser] refused: no remotePublicId for instanceId=%d remoteUserId=%d',
      instanceId,
      remoteUserId
    );
    throw new Error('Shadow users require the remote publicId');
  }
  return findOrCreateShadowUserByPublicId(
    instanceId,
    remotePublicId,
    rawUsername,
    remoteUserId
  );
}

/**
 * Ask a user's home instance to vouch for `publicId` and tell us the name
 * it goes by. The reply is signed by that instance for our audience, so a
 * peer announcing a group DM with members homed on a third instance
 * cannot invent those members — the third instance attests, or the caller
 * skips the member. Null when the instance is not an active peer of ours,
 * is unreachable, does not know the user, or its signature fails.
 */
async function verifyRemoteUserAttestation(
  instanceDomain: string,
  publicId: string
): Promise<{ name: string } | null> {
  // Only an active peer with a pinned key can attest anything — and the
  // domain comes from another peer's announcement, so refuse here rather
  // than let that peer make us sign requests to arbitrary hosts.
  const [peer] = await db
    .select({ publicKey: federationInstances.publicKey })
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, instanceDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);
  if (!peer?.publicKey) return null;

  const info = await queryInstance<{ name?: unknown }>(
    instanceDomain,
    '/federation/user-info',
    { publicId }
  );
  if (!info || typeof info.name !== 'string' || info.name.length === 0) {
    return null;
  }
  return { name: boundShadowName(info.name) };
}

/**
 * Remove every shadow user minted for a peer (instance removed /
 * blocked / federation switched off) together with the DM channels
 * that only existed because of them. Deleting the users cascades
 * `dm_channel_members`, friendships, roles and key rows, but
 * `dm_channels` rows do not reference users: without this sweep a 1:1
 * with a shadow stayed in the local user's sidebar with no counterpart,
 * and a group mirror whose members were all remote lingered empty.
 *
 * Rules: a non-group channel with fewer than two members left goes; a
 * group mirror (`federation_group_id` set) goes only when no member is
 * left — a mixed group with local members left keeps its history, its
 * remaining members just see the shadows drop out. Local-only groups
 * never had a shadow member and are never touched. Affected local
 * users get the same events the leave/remove routes publish, so their
 * client state updates without a refresh.
 */
async function deleteShadowUsersByInstance(
  instanceId: number
): Promise<{ deletedUsers: number; deletedChannels: number }> {
  const shadows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isFederated, true),
        eq(users.federatedInstanceId, instanceId)
      )
    );
  const shadowIds = shadows.map((s) => s.id);
  if (shadowIds.length === 0) return { deletedUsers: 0, deletedChannels: 0 };

  // Channels the shadows sit in, with every member — captured BEFORE
  // the delete so the survivors can be told which member left.
  const touched = await db
    .select({
      channelId: dmChannelMembers.dmChannelId,
      userId: dmChannelMembers.userId,
      isGroup: dmChannels.isGroup,
      federationGroupId: dmChannels.federationGroupId
    })
    .from(dmChannelMembers)
    .innerJoin(dmChannels, eq(dmChannels.id, dmChannelMembers.dmChannelId))
    .where(
      inArray(
        dmChannelMembers.dmChannelId,
        db
          .select({ id: dmChannelMembers.dmChannelId })
          .from(dmChannelMembers)
          .where(inArray(dmChannelMembers.userId, shadowIds))
      )
    );

  const shadowSet = new Set(shadowIds);
  const channels = new Map<
    number,
    { isGroup: boolean; mirror: boolean; remaining: number[]; removed: number[] }
  >();
  for (const row of touched) {
    let entry = channels.get(row.channelId);
    if (!entry) {
      entry = {
        isGroup: row.isGroup,
        mirror: row.federationGroupId !== null,
        remaining: [],
        removed: []
      };
      channels.set(row.channelId, entry);
    }
    (shadowSet.has(row.userId) ? entry.removed : entry.remaining).push(
      row.userId
    );
  }

  const deleted = await db
    .delete(users)
    .where(inArray(users.id, shadowIds))
    .returning({ id: users.id });

  const toDelete: number[] = [];
  for (const [channelId, entry] of channels) {
    const orphaned = entry.isGroup
      ? entry.mirror && entry.remaining.length === 0
      : entry.remaining.length < 2;
    if (orphaned) {
      toDelete.push(channelId);
      continue;
    }
    // Survivors of a mixed group: the shadows left, same event the
    // leave route publishes.
    for (const userId of entry.remaining) {
      for (const removedId of entry.removed) {
        pubsub.publishFor(userId, ServerEvents.DM_MEMBER_REMOVE, {
          dmChannelId: channelId,
          userId: removedId
        });
      }
    }
  }

  if (toDelete.length > 0) {
    await db.delete(dmChannels).where(inArray(dmChannels.id, toDelete));
    for (const channelId of toDelete) {
      for (const userId of channels.get(channelId)!.remaining) {
        pubsub.publishFor(userId, ServerEvents.DM_CHANNEL_DELETE, {
          dmChannelId: channelId
        });
      }
    }
  }

  logger.debug(
    '[deleteShadowUsersByInstance] instanceId=%d users=%d channels=%d',
    instanceId,
    deleted.length,
    toDelete.length
  );
  return { deletedUsers: deleted.length, deletedChannels: toDelete.length };
}


// Caps for federated media proxies (Phase 4 / F3). Federated peers
// can serve arbitrarily large bytes; we don't blindly accept what
// they hand us, especially for proxied avatars/banners that go to
// disk under our PUBLIC_PATH. 10 MB is plenty for any realistic
// avatar/banner, animated formats included.
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
      remoteUrl.replace(/[\r\n]/g, ''),
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
        customStatus: users.customStatus,
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
      issuerDomain.replace(/[\r\n]/g, ''),
      opts?.force ?? false
    );

    // Fetch profile from home instance
    const protocol = getFederationProtocol(issuerDomain);
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
      customStatus?: string | null;
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

    // Sync bio, bannerColor, and custom status — bounded like the
    // push path (user-info-update); the pulled profile is peer data too.
    const bio =
      typeof profile.bio === 'string'
        ? profile.bio.slice(0, MAX_SHADOW_BIO_LENGTH)
        : null;
    if (bio !== shadow.bio) {
      updates.bio = bio;
    }
    const bannerColor =
      typeof profile.bannerColor === 'string' &&
      SHADOW_BANNER_COLOR_RE.test(profile.bannerColor)
        ? profile.bannerColor
        : null;
    if (bannerColor !== shadow.bannerColor) {
      updates.bannerColor = bannerColor;
    }
    // Optional — older peers don't send it; bound like the push path.
    if (
      profile.customStatus !== undefined &&
      profile.customStatus !== shadow.customStatus
    ) {
      updates.customStatus =
        profile.customStatus === null
          ? null
          : String(profile.customStatus).slice(0, 128);
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
    // Sanitize the error text — a federated-sync failure can carry
    // remote-controlled strings into the log sink (CodeQL js/log-injection).
    logger.error(
      '[syncShadowUserProfile] failed for user %d: %s',
      shadowUserId,
      (err instanceof Error ? err.message : String(err)).replace(/[\r\n]/g, '')
    );
  }
}

export {
  deleteShadowUsersByInstance,
  findOrCreateShadowUser,
  findOrCreateShadowUserByPublicId,
  syncShadowUserAvatar,
  syncShadowUserProfile,
  verifyRemoteUserAttestation
};
