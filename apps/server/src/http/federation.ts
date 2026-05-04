import { type TFederationInfo, ServerEvents } from '@pulse/shared';
import { and, eq, count, sql } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import {
  federationInstances,
  servers,
  serverMembers,
  users,
  files,
  userIdentityKeys,
  userSignedPreKeys,
  userOneTimePreKeys
} from '../db/schema';
import { getFirstServer } from '../db/queries/servers';
import { config } from '../config';
import {
  getLocalKeys,
  signedJsonResponse,
  verifyChallenge
} from '../utils/federation';
import { _tryConsumeBundleFetchToken } from '../utils/bundle-fetch-rate-limit';
import { SERVER_VERSION } from '../utils/env';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { logger } from '../logger';
import { alias } from 'drizzle-orm/pg-core';
import { findOrCreateShadowUser, syncShadowUserAvatar } from '../db/mutations/federation';
import { invalidateCorsCache } from './cors';
import { pubsub } from '../utils/pubsub';
import { federationFetch } from '../utils/federation-fetch';
import { validateFederationUrl } from '../utils/validate-url';

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > MAX_BODY_SIZE) {
      req.resume();
      reject(new Error('Request body too large'));
      return;
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown
) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// GET /federation/info — Public instance info
const federationInfoHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 200, { federationEnabled: false });
  }

  const server = await getFirstServer();
  const keys = await getLocalKeys();

  const info: TFederationInfo = {
    domain: config.federation.domain,
    name: server?.name || 'Pulse Instance',
    version: SERVER_VERSION,
    publicKey: keys ? JSON.stringify(keys.publicKey) : '',
    federationEnabled: true
  };

  jsonResponse(res, 200, info);
};

// POST /federation/request — Receive federation request from remote instance
const federationRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { domain, name, publicKey, signature } = body as {
    domain: string;
    name: string;
    publicKey: string;
    signature: string;
  };

  if (!domain || !publicKey || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Verify signature proves key ownership AND binds to the body. The
  // sender signed { domain, name, publicKey } so we re-derive that
  // shape from the wire body (everything except `signature` itself).
  const isValid = await verifyChallenge(
    signature,
    { domain, name, publicKey },
    domain,
    publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  // Reverse verification: independently fetch the public key from the claimed
  // domain's /federation/info endpoint. This prevents domain spoofing — an
  // attacker can't claim "victim.com" because we verify the key at that URL.
  try {
    const protocol = domain.includes('localhost') ? 'http' : 'https';
    const federationInfoUrl = `${protocol}://${domain}/federation/info`;
    const validatedUrl = await validateFederationUrl(federationInfoUrl);
    const infoRes = await federationFetch(validatedUrl.href, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!infoRes.ok) {
      return jsonResponse(res, 400, { error: 'Could not verify domain ownership' });
    }

    const remoteInfo = (await infoRes.json()) as { publicKey?: string };
    if (!remoteInfo.publicKey || remoteInfo.publicKey !== publicKey) {
      logger.warn(
        '[federation/request] Public key mismatch for domain %s — possible spoofing attempt',
        sanitizeForLog(domain)
      );
      return jsonResponse(res, 401, {
        error: 'Public key does not match the key served by the claimed domain'
      });
    }
  } catch (err) {
    logger.error('[federation/request] Failed to verify domain %s:', sanitizeForLog(domain), err);
    return jsonResponse(res, 400, {
      error: 'Could not verify domain ownership — unable to reach the claimed domain'
    });
  }

  // Check if already exists
  const [existing] = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.domain, domain))
    .limit(1);

  if (existing) {
    if (existing.status === 'blocked') {
      return jsonResponse(res, 403, { error: 'Instance is blocked' });
    }

    // Update existing record
    await db
      .update(federationInstances)
      .set({
        name: name as string || null,
        publicKey,
        direction:
          existing.direction === 'outgoing' ? 'mutual' : existing.direction,
        status:
          existing.direction === 'outgoing' ? 'active' : existing.status,
        lastSeenAt: Date.now(),
        updatedAt: Date.now()
      })
      .where(eq(federationInstances.id, existing.id));

    if (existing.direction === 'outgoing') {
      invalidateCorsCache();
    }

    pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
      domain,
      status: existing.direction === 'outgoing' ? 'active' : existing.status
    });

    return jsonResponse(res, 200, {
      success: true,
      status: existing.direction === 'outgoing' ? 'active' : existing.status
    });
  }

  // Create new incoming request
  await db.insert(federationInstances).values({
    domain,
    name: name as string || null,
    publicKey,
    status: 'pending',
    direction: 'incoming',
    createdAt: Date.now()
  });

  pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
    domain,
    status: 'pending'
  });

  jsonResponse(res, 200, { success: true, status: 'pending' });
};

// POST /federation/accept — Remote instance confirms mutual federation
const federationAcceptHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { domain, signature } = body as {
    domain: string;
    signature: string;
  };

  if (!domain || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.domain, domain))
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 404, { error: 'Instance not found' });
  }

  if (instance.status === 'blocked') {
    return jsonResponse(res, 403, { error: 'Instance is blocked' });
  }

  // Only auto-activate if the local admin initiated this connection (outgoing)
  // or already explicitly approved it (active). Prevents a remote instance from
  // auto-activating an incoming request that hasn't been approved locally.
  if (instance.direction === 'incoming' && instance.status === 'pending') {
    return jsonResponse(res, 403, {
      error: 'Instance not yet approved by local administrator'
    });
  }

  // Sender signed { domain } and we look the publicKey up by that domain.
  const isValid = await verifyChallenge(
    signature,
    { domain },
    domain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  await db
    .update(federationInstances)
    .set({
      status: 'active',
      direction: 'mutual',
      lastSeenAt: Date.now(),
      updatedAt: Date.now()
    })
    .where(eq(federationInstances.id, instance.id));

  invalidateCorsCache();

  pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
    domain,
    status: 'active'
  });

  jsonResponse(res, 200, { success: true });
};

// GET /federation/servers — List federatable servers (instance-to-instance)
const federationServersHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`);
  const requesterDomain = url.searchParams.get('requesterDomain');

  if (!requesterDomain) {
    return jsonResponse(res, 400, { error: 'Missing requesterDomain' });
  }

  // Verify requester is an active federated instance
  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, requesterDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance) {
    return jsonResponse(res, 403, { error: 'Not a trusted instance' });
  }

  const logoFiles = alias(files, 'logoFiles');

  const federatableServers = await db
    .select({
      publicId: servers.publicId,
      name: servers.name,
      description: servers.description,
      logo: logoFiles,
      id: servers.id,
      password: servers.password
    })
    .from(servers)
    .leftJoin(logoFiles, eq(servers.logoId, logoFiles.id))
    .where(eq(servers.federatable, true));

  // Get member counts
  const serverList = await Promise.all(
    federatableServers.map(async (s) => {
      const [result] = await db
        .select({ memberCount: count() })
        .from(serverMembers)
        .where(eq(serverMembers.serverId, s.id));

      return {
        publicId: s.publicId,
        name: s.name,
        description: s.description,
        logo: s.logo,
        memberCount: result?.memberCount || 0,
        federatable: true as const,
        hasPassword: !!s.password
      };
    })
  );

  jsonResponse(res, 200, { servers: serverList });
};

// POST /federation/user-info — Remote instance fetches user profile
const federationUserInfoHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { userId, publicId, fromDomain, signature } = body as {
    userId?: number;
    publicId?: string;
    fromDomain?: string;
    signature: string;
  };

  if ((!userId && !publicId) || !fromDomain || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields (publicId or userId, fromDomain, signature)' });
  }

  // Look up the claimed source instance and verify ONLY against its pubkey.
  // The previous "iterate all active instances and accept any match" pattern
  // let any peer's signature satisfy any peer's request — fixed 2026-05-02.
  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 401, { error: 'Unknown or inactive instance' });
  }

  // Sender signed { publicId, fromDomain }. userId is in the body but
  // wasn't part of the signed shape historically; we keep it that way
  // so signatures don't break if a peer omits it.
  const isValid = await verifyChallenge(
    signature,
    { publicId, fromDomain },
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  const logoFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  // Prefer publicId lookup, fall back to numeric userId for backwards compat
  const whereClause = publicId
    ? eq(users.publicId, publicId)
    : eq(users.id, userId!);

  const [user] = await db
    .select({
      name: users.name,
      bio: users.bio,
      bannerColor: users.bannerColor,
      avatar: logoFiles,
      banner: bannerFiles,
      createdAt: users.createdAt
    })
    .from(users)
    .leftJoin(logoFiles, eq(users.avatarId, logoFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(whereClause)
    .limit(1);

  if (!user) {
    return jsonResponse(res, 404, { error: 'User not found' });
  }

  jsonResponse(res, 200, user);
};

// POST /federation/friend-request — Forward friend request to remote user
const federationFriendRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;
  const fromUsername = signedBody.fromUsername as string;
  const fromPublicId = signedBody.fromPublicId as string;
  const fromUserId = signedBody.fromUserId as number | undefined;
  const fromAvatarFile = signedBody.fromAvatarFile as string | undefined;
  const toPublicId = signedBody.toPublicId as string;

  if (!fromDomain || !fromUsername || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Require UUIDs — reject requests without them to prevent impersonation
  if (!fromPublicId || !toPublicId) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  // Verify signature from the sending instance
  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 403, { error: 'Not a trusted instance' });
  }

  // Receive-side: signedBody is the full wire body minus `signature`,
  // which exactly matches what relayToInstance signed (payload +
  // fromDomain). Canonicalization handles key-order on both sides.
  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  // Find local target user by publicId only — no name fallback
  const [targetUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, toPublicId))
    .limit(1);

  if (!targetUser) {
    return jsonResponse(res, 404, { error: 'User not found' });
  }

  // Create/find shadow user for the sender (identified by UUID)
  const shadowUser = await findOrCreateShadowUser(
    instance.id,
    fromUserId ?? 0,
    fromUsername,
    undefined,
    fromPublicId
  );

  // Sync avatar from remote instance (fire-and-forget)
  if (fromAvatarFile) {
    const protocol = fromDomain.includes('localhost') ? 'http' : 'https';
    syncShadowUserAvatar(shadowUser.id, `${protocol}://${fromDomain}/public/${fromAvatarFile}`);
  }

  // Import friend request creation dynamically to avoid circular dependencies
  const { friendRequests } = await import('../db/schema');
  await db.insert(friendRequests).values({
    senderId: shadowUser.id,
    receiverId: targetUser.id,
    status: 'pending',
    createdAt: Date.now()
  }).onConflictDoNothing();

  // Publish event to local user so they see the request in real-time
  const { getJoinedFriendRequest } = await import('../db/queries/friends');
  const { pubsub } = await import('../utils/pubsub');
  const { ServerEvents } = await import('@pulse/shared');

  // Find the request we just created
  const [newRequest] = await db
    .select()
    .from(friendRequests)
    .where(
      and(
        eq(friendRequests.senderId, shadowUser.id),
        eq(friendRequests.receiverId, targetUser.id),
        eq(friendRequests.status, 'pending')
      )
    )
    .limit(1);

  if (newRequest) {
    const joined = await getJoinedFriendRequest(newRequest.id);
    if (joined) {
      pubsub.publishFor(
        targetUser.id,
        ServerEvents.FRIEND_REQUEST_RECEIVED,
        joined
      );
    }
  }

  jsonResponse(res, 200, { success: true });
};

// POST /federation/friend-accept — Forward friend acceptance
const federationFriendAcceptHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;
  const fromUsername = signedBody.fromUsername as string;
  const fromPublicId = signedBody.fromPublicId as string;
  const fromUserId = signedBody.fromUserId as number | undefined;
  const fromAvatarFile = signedBody.fromAvatarFile as string | undefined;
  const toPublicId = signedBody.toPublicId as string;

  if (!fromDomain || !fromUsername || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Require UUIDs — reject requests without them to prevent impersonation
  if (!fromPublicId || !toPublicId) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 403, { error: 'Not a trusted instance' });
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  // Find shadow user for the accepter (identified by UUID)
  const shadowUser = await findOrCreateShadowUser(
    instance.id,
    fromUserId ?? 0,
    fromUsername,
    undefined,
    fromPublicId
  );

  // Sync avatar from remote instance (fire-and-forget)
  if (fromAvatarFile) {
    const protocol = fromDomain.includes('localhost') ? 'http' : 'https';
    syncShadowUserAvatar(shadowUser.id, `${protocol}://${fromDomain}/public/${fromAvatarFile}`);
  }

  // Find local user by publicId only — no name fallback
  const [localUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, toPublicId))
    .limit(1);

  if (!localUser) {
    return jsonResponse(res, 404, { error: 'Local user not found' });
  }

  // Find the pending friend request from localUser -> shadowUser
  const { friendRequests, friendships } = await import('../db/schema');
  const [pendingRequest] = await db
    .select()
    .from(friendRequests)
    .where(
      and(
        eq(friendRequests.senderId, localUser.id),
        eq(friendRequests.receiverId, shadowUser.id),
        eq(friendRequests.status, 'pending')
      )
    )
    .limit(1);

  if (!pendingRequest) {
    return jsonResponse(res, 404, { error: 'No pending friend request found' });
  }

  // Accept the request
  await db
    .update(friendRequests)
    .set({ status: 'accepted', updatedAt: Date.now() })
    .where(eq(friendRequests.id, pendingRequest.id));

  // Create friendship record
  await db.insert(friendships).values({
    userId: pendingRequest.senderId,
    friendId: pendingRequest.receiverId,
    createdAt: Date.now()
  });

  // Publish events to local user
  const { getJoinedFriendRequest } = await import('../db/queries/friends');
  const { pubsub } = await import('../utils/pubsub');
  const { ServerEvents } = await import('@pulse/shared');

  const joined = await getJoinedFriendRequest(pendingRequest.id);
  if (joined) {
    pubsub.publishFor(
      localUser.id,
      ServerEvents.FRIEND_REQUEST_ACCEPTED,
      joined
    );
  }

  jsonResponse(res, 200, { success: true });
};

// POST /federation/friend-remove — Forward friend removal
const federationFriendRemoveHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;
  const fromPublicId = signedBody.fromPublicId as string;
  const toPublicId = signedBody.toPublicId as string;

  if (!fromDomain || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Require UUIDs — reject requests without them to prevent impersonation
  if (!fromPublicId || !toPublicId) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 403, { error: 'Not a trusted instance' });
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  // Find shadow user by federatedPublicId only — no name fallback
  const [shadowUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.isFederated, true),
        eq(users.federatedInstanceId, instance.id),
        eq(users.federatedPublicId, fromPublicId)
      )
    )
    .limit(1);

  if (!shadowUser) {
    return jsonResponse(res, 404, { error: 'Shadow user not found' });
  }

  // Find local user by publicId only — no name fallback
  const [localUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, toPublicId))
    .limit(1);

  if (!localUser) {
    return jsonResponse(res, 404, { error: 'Local user not found' });
  }

  // Delete friendship in both directions
  const { friendships } = await import('../db/schema');
  const { or: drizzleOr } = await import('drizzle-orm');

  await db
    .delete(friendships)
    .where(
      drizzleOr(
        and(
          eq(friendships.userId, shadowUser.id),
          eq(friendships.friendId, localUser.id)
        ),
        and(
          eq(friendships.userId, localUser.id),
          eq(friendships.friendId, shadowUser.id)
        )
      )
    );

  // Publish event to local user
  const { pubsub } = await import('../utils/pubsub');
  const { ServerEvents } = await import('@pulse/shared');

  const payload = { userId: shadowUser.id, friendId: localUser.id };
  pubsub.publishFor(localUser.id, ServerEvents.FRIEND_REMOVED, payload);

  jsonResponse(res, 200, { success: true });
};

// POST /federation/dm-relay — Relay DM message to local user
const federationDmRelayHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;
  const fromUsername = signedBody.fromUsername as string;
  const fromPublicId = signedBody.fromPublicId as string;
  const fromAvatarFile = signedBody.fromAvatarFile as string | undefined;
  const toPublicId = signedBody.toPublicId as string;
  const content = signedBody.content as string;
  // Phase D / D1 — when set, `content` is base64-encoded Signal
  // ciphertext (PreKeyMessage on first contact, regular message
  // afterwards). The receiving instance never decrypts; it just
  // routes the envelope to the recipient's WS and persists the
  // ciphertext to dmMessages with the e2ee flag set. Optional,
  // defaults false to preserve the pre-Phase-D plaintext behaviour
  // for in-flight v0.2 traffic.
  const isE2ee = signedBody.e2ee === true;

  if (!fromDomain || !fromUsername || !content || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Require UUIDs — reject requests without them to prevent impersonation
  if (!fromPublicId || !toPublicId) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 403, { error: 'Not a trusted instance' });
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  const fromUserId = (signedBody.fromUserId as number) ?? 0;

  // Find or create shadow user for the sender (identified by UUID)
  const shadowUser = await findOrCreateShadowUser(
    instance.id,
    fromUserId,
    fromUsername,
    undefined,
    fromPublicId
  );

  // Sync avatar from remote instance (fire-and-forget)
  if (fromAvatarFile) {
    const protocol = fromDomain.includes('localhost') ? 'http' : 'https';
    syncShadowUserAvatar(shadowUser.id, `${protocol}://${fromDomain}/public/${fromAvatarFile}`);
  }

  // Find local target user by publicId only — no name fallback
  const [localUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, toPublicId))
    .limit(1);

  if (!localUser) {
    return jsonResponse(res, 404, { error: 'Local user not found' });
  }

  // Find or create DM channel between shadow user and local user
  const { findDmChannelBetween, getDmMessage } = await import('../db/queries/dms');
  const { dmChannels, dmChannelMembers, dmMessages } = await import('../db/schema');

  let dmChannelId = await findDmChannelBetween(shadowUser.id, localUser.id);
  let channelE2eeFlipped = false;

  if (!dmChannelId) {
    // New channel — initialise its e2ee flag from the incoming envelope.
    const [newChannel] = await db
      .insert(dmChannels)
      .values({ createdAt: Date.now(), e2ee: isE2ee })
      .returning();

    dmChannelId = newChannel!.id;

    await db.insert(dmChannelMembers).values([
      { dmChannelId: dmChannelId, userId: shadowUser.id, createdAt: Date.now() },
      { dmChannelId: dmChannelId, userId: localUser.id, createdAt: Date.now() }
    ]);
  } else if (isE2ee) {
    // Existing channel that's still flagged plaintext on this side
    // (e.g. previous messages were plaintext). The remote sender just
    // upgraded their side via `enableEncryption` — auto-upgrade ours
    // so the recipient's UI flips to the encrypted state. Encryption
    // is one-way (no auto-disable); plaintext arriving on an already-
    // encrypted channel falls through to the existing-channel path
    // without flipping the flag back.
    const [existing] = await db
      .select({ e2ee: dmChannels.e2ee })
      .from(dmChannels)
      .where(eq(dmChannels.id, dmChannelId))
      .limit(1);
    if (existing && !existing.e2ee) {
      await db
        .update(dmChannels)
        .set({ e2ee: true, updatedAt: Date.now() })
        .where(eq(dmChannels.id, dmChannelId));
      channelE2eeFlipped = true;
    }
  }

  // Insert message
  const [message] = await db
    .insert(dmMessages)
    .values({
      dmChannelId,
      userId: shadowUser.id,
      content,
      e2ee: isE2ee,
      createdAt: Date.now()
    })
    .returning();

  // Notify the recipient that the channel just became encrypted so
  // their client refreshes the badge + composer state. Same event
  // shape as the same-instance `enableEncryption` mutation.
  if (channelE2eeFlipped) {
    pubsub.publishFor(localUser.id, ServerEvents.DM_CHANNEL_UPDATE, {
      dmChannelId,
      name: null,
      iconFileId: null
    });
  }

  // Publish event to local user
  const joined = await getDmMessage(message!.id);
  if (joined) {
    const { pubsub } = await import('../utils/pubsub');
    const { ServerEvents } = await import('@pulse/shared');

    pubsub.publishFor(localUser.id, ServerEvents.DM_NEW_MESSAGE, joined);
  }

  jsonResponse(res, 200, { success: true });
};

// POST /federation/report-user — Report a federated user to their home instance
const federationReportUserHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;
  const username = signedBody.username as string;
  const reason = signedBody.reason as string;

  if (!fromDomain || !username || !reason || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 403, { error: 'Not a trusted instance' });
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  logger.info(
    'Federation report received from %s for user %s: %s',
    sanitizeForLog(fromDomain),
    sanitizeForLog(username),
    sanitizeForLog(reason)
  );

  jsonResponse(res, 200, { success: true });
};

// POST /federation/get-prekey-bundle — return a signed pre-key bundle
// for a local user, addressed by publicId. Phase D / D1 — used by
// remote peers when their user wants to start a cross-instance E2EE
// DM with one of our users.
//
// Auth: signed request body (Phase 4 / F1). Response is signed via
// Phase D / D0 (`signedJsonResponse`) so the requester can detect a
// TLS-only-MITM that substituted bundle data in flight.
//
// DoS protection: per-publicId token bucket stops a hostile peer
// from enumerating to drain a user's one-time pre-key pool.
const federationGetPreKeyBundleHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;
  const targetPublicId = signedBody.targetPublicId as string;

  if (!fromDomain || !targetPublicId || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    return jsonResponse(res, 403, { error: 'Not a trusted instance' });
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  // Per-publicId rate limit (DoS / OTPK-pool-drain protection).
  // Applied AFTER signature verification so unsigned probes don't
  // even register against a publicId's bucket.
  if (!_tryConsumeBundleFetchToken(targetPublicId)) {
    return jsonResponse(res, 429, {
      error: 'Bundle fetch rate limit exceeded'
    });
  }

  const [localUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, targetPublicId))
    .limit(1);

  if (!localUser) {
    return jsonResponse(res, 404, { error: 'Local user not found' });
  }

  const [identityKey] = await db
    .select()
    .from(userIdentityKeys)
    .where(eq(userIdentityKeys.userId, localUser.id))
    .limit(1);

  if (!identityKey) {
    return jsonResponse(res, 404, { error: 'User has no identity key' });
  }

  const [signedPreKeyRow] = await db
    .select()
    .from(userSignedPreKeys)
    .where(eq(userSignedPreKeys.userId, localUser.id))
    .orderBy(sql`${userSignedPreKeys.createdAt} DESC`)
    .limit(1);

  if (!signedPreKeyRow) {
    return jsonResponse(res, 404, { error: 'User has no signed pre-key' });
  }

  // Consume one OTPK (FIFO — delete oldest, return it). Atomic via
  // single-statement subquery, same pattern as the same-instance
  // `e2ee.getPreKeyBundle` route. Returns null in `oneTimePreKey`
  // when the pool is empty — clients fall back to `signedPreKey`-
  // only X3DH (loses one round of forward secrecy until OTPKs
  // replenish).
  const [oneTimePreKey] = await db
    .delete(userOneTimePreKeys)
    .where(
      eq(
        userOneTimePreKeys.id,
        db
          .select({ id: userOneTimePreKeys.id })
          .from(userOneTimePreKeys)
          .where(eq(userOneTimePreKeys.userId, localUser.id))
          .orderBy(sql`${userOneTimePreKeys.createdAt} ASC`)
          .limit(1)
      )
    )
    .returning();

  return signedJsonResponse(
    res,
    200,
    {
      identityPublicKey: identityKey.identityPublicKey,
      registrationId: identityKey.registrationId,
      signedPreKey: {
        keyId: signedPreKeyRow.keyId,
        publicKey: signedPreKeyRow.publicKey,
        signature: signedPreKeyRow.signature
      },
      oneTimePreKey: oneTimePreKey
        ? {
            keyId: oneTimePreKey.keyId,
            publicKey: oneTimePreKey.publicKey
          }
        : null
    },
    fromDomain
  );
};

export {
  federationAcceptHandler,
  federationDmRelayHandler,
  federationFriendAcceptHandler,
  federationFriendRemoveHandler,
  federationFriendRequestHandler,
  federationGetPreKeyBundleHandler,
  federationInfoHandler,
  federationReportUserHandler,
  federationRequestHandler,
  federationServersHandler,
  federationUserInfoHandler
};
