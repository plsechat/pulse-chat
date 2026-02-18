import { type TFederationInfo, ServerEvents } from '@pulse/shared';
import { and, eq, count } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { federationInstances, servers, serverMembers, users, files } from '../db/schema';
import { getFirstServer } from '../db/queries/servers';
import { config } from '../config';
import {
  getLocalKeys,
  verifyChallenge
} from '../utils/federation';
import { SERVER_VERSION } from '../utils/env';
import { logger } from '../logger';
import { alias } from 'drizzle-orm/pg-core';
import { findOrCreateShadowUser, syncShadowUserAvatar } from '../db/mutations/federation';
import { invalidateCorsCache } from './cors';
import { pubsub } from '../utils/pubsub';

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

  // Verify signature proves key ownership
  const isValid = await verifyChallenge(signature, publicKey);
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  // Reverse verification: independently fetch the public key from the claimed
  // domain's /federation/info endpoint. This prevents domain spoofing — an
  // attacker can't claim "victim.com" because we verify the key at that URL.
  try {
    const protocol = domain.includes('localhost') ? 'http' : 'https';
    const infoRes = await fetch(`${protocol}://${domain}/federation/info`, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!infoRes.ok) {
      return jsonResponse(res, 400, { error: 'Could not verify domain ownership' });
    }

    const remoteInfo = (await infoRes.json()) as { publicKey?: string };
    if (!remoteInfo.publicKey || remoteInfo.publicKey !== publicKey) {
      logger.warn(
        '[federation/request] Public key mismatch for domain %s — possible spoofing attempt',
        domain
      );
      return jsonResponse(res, 401, {
        error: 'Public key does not match the key served by the claimed domain'
      });
    }
  } catch (err) {
    logger.error('[federation/request] Failed to verify domain %s:', domain, err);
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

  const isValid = await verifyChallenge(signature, instance.publicKey);
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
      id: servers.id
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
        federatable: true as const
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
  const { userId, publicId, signature } = body as {
    userId?: number;
    publicId?: string;
    signature: string;
  };

  if ((!userId && !publicId) || !signature) {
    return jsonResponse(res, 400, { error: 'Missing required fields (publicId or userId + signature)' });
  }

  // Verify signature is from a trusted instance
  // We need to check all active instances since we don't know which one is calling
  const activeInstances = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.status, 'active'));

  let verified = false;
  for (const instance of activeInstances) {
    if (instance.publicKey) {
      const isValid = await verifyChallenge(signature, instance.publicKey);
      if (isValid) {
        verified = true;
        break;
      }
    }
  }

  if (!verified) {
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
  const { fromDomain, fromUsername, fromUserId, fromPublicId, fromAvatarFile, toPublicId, signature } = body as {
    fromDomain: string;
    fromUsername: string;
    fromUserId?: number;
    fromPublicId: string;
    fromAvatarFile?: string;
    toPublicId: string;
    signature: string;
  };

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

  const isValid = await verifyChallenge(signature, instance.publicKey);
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
  const { fromDomain, fromUsername, fromUserId, fromPublicId, fromAvatarFile, toPublicId, signature } = body as {
    fromDomain: string;
    fromUsername: string;
    fromUserId?: number;
    fromPublicId: string;
    fromAvatarFile?: string;
    toPublicId: string;
    signature: string;
  };

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

  const isValid = await verifyChallenge(signature, instance.publicKey);
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
  const { fromDomain, fromPublicId, toPublicId, signature } = body as {
    fromDomain: string;
    fromPublicId: string;
    toPublicId: string;
    signature: string;
  };

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

  const isValid = await verifyChallenge(signature, instance.publicKey);
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
  const { fromDomain, fromUsername, fromPublicId, fromAvatarFile, toPublicId, content, signature } = body as {
    fromDomain: string;
    fromUsername: string;
    fromPublicId: string;
    fromAvatarFile?: string;
    toPublicId: string;
    content: string;
    signature: string;
  };

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

  const isValid = await verifyChallenge(signature, instance.publicKey);
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  const fromUserId = (body.fromUserId as number) ?? 0;

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

  if (!dmChannelId) {
    const [newChannel] = await db
      .insert(dmChannels)
      .values({ createdAt: Date.now() })
      .returning();

    dmChannelId = newChannel!.id;

    await db.insert(dmChannelMembers).values([
      { dmChannelId: dmChannelId, userId: shadowUser.id, createdAt: Date.now() },
      { dmChannelId: dmChannelId, userId: localUser.id, createdAt: Date.now() }
    ]);
  }

  // Insert message
  const [message] = await db
    .insert(dmMessages)
    .values({
      dmChannelId,
      userId: shadowUser.id,
      content,
      createdAt: Date.now()
    })
    .returning();

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
  const { fromDomain, username, reason, signature } = body as {
    fromDomain: string;
    username: string;
    reason: string;
    signature: string;
  };

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

  const isValid = await verifyChallenge(signature, instance.publicKey);
  if (!isValid) {
    return jsonResponse(res, 401, { error: 'Invalid signature' });
  }

  logger.info(
    'Federation report received from %s for user %s: %s',
    fromDomain,
    username,
    reason
  );

  jsonResponse(res, 200, { success: true });
};

export {
  federationAcceptHandler,
  federationDmRelayHandler,
  federationFriendAcceptHandler,
  federationFriendRemoveHandler,
  federationFriendRequestHandler,
  federationInfoHandler,
  federationReportUserHandler,
  federationRequestHandler,
  federationServersHandler,
  federationUserInfoHandler
};
