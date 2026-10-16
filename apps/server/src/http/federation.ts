import {
  type TFederationInfo,
  MAX_MESSAGE_WIRE_LENGTH,
  ServerEvents
} from '@pulse/shared';
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import http from 'http';
import { db } from '../db';
import {
  dmChannelMembers,
  dmChannels,
  dmMessages,
  federationInstances,
  files,
  friendRequests,
  friendships,
  reports,
  serverMembers,
  servers,
  userIdentityKeys,
  userOneTimePreKeys,
  users,
  userSignedPreKeys
} from '../db/schema';
import { isBlockBetween } from '../db/queries/blocks';
import { findDmChannelBetween, getDmMessage } from '../db/queries/dms';
import { areFriends, getJoinedFriendRequest } from '../db/queries/friends';
import { getFirstServer, sharesServerWith } from '../db/queries/servers';
import { getOrCreatePairChannel } from '../db/mutations/dms';
import {
  deleteShadowUsersByInstance,
  findOrCreateShadowUserByPublicId,
  syncShadowUserAvatar
} from '../db/mutations/federation';
import { config } from '../config';
import {
  getLocalKeys,
  signedJsonResponse,
  verifyChallenge
} from '../utils/federation';
import { _tryConsumeBundleFetchToken } from '../utils/bundle-fetch-rate-limit';
import { federationFetch } from '../utils/federation-fetch';
import { fetchPeerVersion, peerVersionFrom } from '../utils/federation-peer-version';
import { SERVER_VERSION } from '../utils/env';
import { pubsub } from '../utils/pubsub';
import { getFederationProtocol, validateFederationUrl } from '../utils/validate-url';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { logger } from '../logger';
import { invalidateCorsCache } from './cors';
import {
  authorizeFederationRequest,
  isPeerDomain,
  isPeerPublicId,
  isPeerPublicKey,
  jsonResponse,
  MAX_PEER_NAME_LENGTH,
  MAX_PEER_REPORT_TEXT_LENGTH,
  MAX_PEER_SERVER_NAME_LENGTH,
  parseBody,
  peerFileName,
  peerInteger,
  peerString
} from './federation-helpers';

/**
 * Unapproved incoming peering requests waiting in the owner's list. The
 * request route is unauthenticated by nature (the key arrives in the
 * body), so without a ceiling anyone with wildcard DNS could fill the
 * approval list with junk rows.
 */
const MAX_PENDING_INCOMING_REQUESTS = 50;

/** `relayId` is a uuidv7 (36 chars); bound it like any other peer id. */
const MAX_RELAY_ID_LENGTH = 64;

/** Report enums as the local reports.create route validates them. */
const REPORT_KINDS = new Set(['message', 'dm_message', 'user']);
const REPORT_REASONS = new Set(['illegal', 'spam', 'harassment', 'other']);

const MAX_PEER_USER_ID = 2 ** 31 - 1;

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

/**
 * Independently fetch what `domain` advertises at /federation/info. Null
 * when it cannot be reached or does not answer 2xx — the caller decides
 * whether that is a refusal (peering) or a retry (key rotation).
 */
const fetchPeerInfo = async (
  domain: string
): Promise<Partial<TFederationInfo> | null> => {
  try {
    const protocol = getFederationProtocol(domain);
    const validatedUrl = await validateFederationUrl(
      `${protocol}://${domain}/federation/info`
    );
    const infoRes = await federationFetch(validatedUrl.href, {
      signal: AbortSignal.timeout(10_000)
    });
    if (!infoRes.ok) return null;
    return (await infoRes.json()) as Partial<TFederationInfo>;
  } catch (err) {
    logger.warn(
      '[federation] could not fetch /federation/info from %s: %s',
      sanitizeForLog(domain),
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
};

// POST /federation/request — Receive federation request from remote instance.
// Unauthenticated by design: the key arrives in the body and is proven by
// (1) the signature over the body and (2) the same key being served at the
// claimed domain's /federation/info. Everything stored is bounded.
const federationRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  if (!config.federation.enabled) {
    return jsonResponse(res, 403, { error: 'Federation not enabled' });
  }

  const body = await parseBody(req);
  const { domain, name, publicKey, signature } = body as {
    domain: unknown;
    name: unknown;
    publicKey: unknown;
    signature: unknown;
  };

  if (!domain || !publicKey || typeof signature !== 'string') {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // `domain` is stored and later interpolated into
  // `${protocol}://${domain}${path}` — it must be a bare host[:port],
  // never a path or userinfo that would redirect our outbound calls.
  if (!isPeerDomain(domain)) {
    return jsonResponse(res, 400, { error: 'Invalid domain' });
  }

  // The key is stored verbatim and parsed on every signature check;
  // bound it and require the one shape we ever verify with (Ed25519 OKP).
  if (!isPeerPublicKey(publicKey)) {
    return jsonResponse(res, 400, { error: 'Invalid public key' });
  }

  // Display name: truncated, never rejected (the signature covers the
  // original `name`, so verification below uses the wire value).
  const storedName = peerString(name, MAX_PEER_SERVER_NAME_LENGTH) || null;

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

  const [existing] = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.domain, domain))
    .limit(1);

  if (existing?.status === 'blocked') {
    return jsonResponse(res, 403, { error: 'Instance is blocked' });
  }

  if (!existing) {
    const [row] = await db
      .select({ pending: count() })
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.status, 'pending'),
          eq(federationInstances.direction, 'incoming')
        )
      );
    if ((row?.pending ?? 0) >= MAX_PENDING_INCOMING_REQUESTS) {
      logger.warn(
        '[federation/request] refusing %s — %d incoming requests already pending',
        sanitizeForLog(domain),
        row?.pending ?? 0
      );
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': '3600'
      });
      res.end(
        JSON.stringify({ error: 'Too many pending federation requests' })
      );
      return;
    }
  }

  // Reverse verification: independently fetch the public key from the claimed
  // domain's /federation/info endpoint. This prevents domain spoofing — an
  // attacker can't claim "victim.com" because we verify the key at that URL.
  const remoteInfo = await fetchPeerInfo(domain);
  if (!remoteInfo) {
    return jsonResponse(res, 400, {
      error: 'Could not verify domain ownership — unable to reach the claimed domain'
    });
  }
  if (!remoteInfo.publicKey || remoteInfo.publicKey !== publicKey) {
    logger.warn(
      '[federation/request] Public key mismatch for domain %s — possible spoofing attempt',
      sanitizeForLog(domain)
    );
    return jsonResponse(res, 401, {
      error: 'Public key does not match the key served by the claimed domain'
    });
  }
  // The peer's advertised release, captured while we hold its /info anyway.
  const peerVersion = peerVersionFrom(remoteInfo);

  if (existing) {
    const now = Date.now();
    const status = existing.direction === 'outgoing' ? 'active' : existing.status;
    // A re-request with a different key is a re-pin proven by the
    // reverse fetch; keep the old key verifying for the grace window so
    // relays the peer signed just before are not refused.
    const keyChanged = !!existing.publicKey && existing.publicKey !== publicKey;

    await db
      .update(federationInstances)
      .set({
        name: storedName,
        publicKey,
        ...(keyChanged
          ? { previousPublicKey: existing.publicKey, keyRotatedAt: now }
          : {}),
        ...(peerVersion !== null ? { peerVersion } : {}),
        direction:
          existing.direction === 'outgoing' ? 'mutual' : existing.direction,
        status,
        lastSeenAt: now,
        updatedAt: now
      })
      .where(eq(federationInstances.id, existing.id));

    if (existing.direction === 'outgoing') {
      invalidateCorsCache();
    }

    pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, { domain, status });

    return jsonResponse(res, 200, { success: true, status });
  }

  // Create new incoming request
  await db.insert(federationInstances).values({
    domain,
    name: storedName,
    publicKey,
    peerVersion,
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

// POST /federation/accept — Remote instance confirms mutual federation.
// The sender's row is still `pending` on our side when WE initiated the
// pairing, so the prologue admits pending rows; an incoming request the
// local owner has not approved is refused below.
const federationAcceptHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res, {
    statuses: ['active', 'pending'],
    fallbackSenderField: 'domain'
  });
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  // `domain` is the sender naming itself; it must be the peer whose key
  // just verified the body.
  if (signedBody.domain !== undefined && signedBody.domain !== fromDomain) {
    return jsonResponse(res, 400, { error: 'domain does not match the signer' });
  }

  // Only auto-activate if the local admin initiated this connection (outgoing)
  // or already explicitly approved it (active). Prevents a remote instance from
  // auto-activating an incoming request that hasn't been approved locally.
  if (instance.direction === 'incoming' && instance.status === 'pending') {
    return jsonResponse(res, 403, {
      error: 'Instance not yet approved by local administrator'
    });
  }

  // Best effort: the peer is reachable right now (it just called us), so
  // record which release it runs for the compatibility badge.
  const peerVersion = await fetchPeerVersion(fromDomain);

  await db
    .update(federationInstances)
    .set({
      status: 'active',
      direction: 'mutual',
      ...(peerVersion !== null ? { peerVersion } : {}),
      lastSeenAt: Date.now(),
      updatedAt: Date.now()
    })
    .where(eq(federationInstances.id, instance.id));

  invalidateCorsCache();

  pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
    domain: fromDomain,
    status: 'active'
  });

  jsonResponse(res, 200, { success: true });
};

// POST /federation/servers — List federatable servers (instance-to-instance).
// Signed like every other route: the list (member counts, password
// flags) is for peers, not for anyone who knows a peer's domain.
const federationServersHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { fromDomain } = auth;

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

  // One grouped count for every listed server instead of a query each.
  const memberCounts = new Map<number, number>();
  if (federatableServers.length > 0) {
    const counts = await db
      .select({ serverId: serverMembers.serverId, memberCount: count() })
      .from(serverMembers)
      .where(
        inArray(
          serverMembers.serverId,
          federatableServers.map((s) => s.id)
        )
      )
      .groupBy(serverMembers.serverId);
    for (const row of counts) memberCounts.set(row.serverId, row.memberCount);
  }

  const serverList = federatableServers.map((s) => ({
    publicId: s.publicId,
    name: s.name,
    description: s.description,
    logo: s.logo,
    memberCount: memberCounts.get(s.id) ?? 0,
    federatable: true as const,
    hasPassword: !!s.password
  }));

  return signedJsonResponse(res, 200, { servers: serverList }, fromDomain);
};

// POST /federation/user-info — a peer fetches one of OUR users' profile.
// publicId only: serial ids are guessable and would let a peer walk every
// local profile. Only users homed here are answered — this reply is the
// home instance vouching for the user (verifyRemoteUserAttestation), so
// it is signed and never covers shadows of a third instance.
const federationUserInfoHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { signedBody, fromDomain } = auth;

  const publicId = signedBody.publicId;
  if (!isPeerPublicId(publicId)) {
    return jsonResponse(res, 400, { error: 'Missing publicId' });
  }

  const avatarFiles = alias(files, 'avatarFiles');
  const bannerFiles = alias(files, 'bannerFiles');

  const [user] = await db
    .select({
      name: users.name,
      bio: users.bio,
      bannerColor: users.bannerColor,
      customStatus: users.customStatus,
      avatar: avatarFiles,
      banner: bannerFiles,
      createdAt: users.createdAt
    })
    .from(users)
    .leftJoin(avatarFiles, eq(users.avatarId, avatarFiles.id))
    .leftJoin(bannerFiles, eq(users.bannerId, bannerFiles.id))
    .where(and(eq(users.publicId, publicId), eq(users.isFederated, false)))
    .limit(1);

  if (!user) {
    return jsonResponse(res, 404, { error: 'User not found' });
  }

  return signedJsonResponse(res, 200, user, fromDomain);
};

/**
 * The sender's user as every social/DM relay describes it. The numeric
 * id is informational only (never a lookup key); the avatar file name is
 * interpolated into a `/public/` URL on the peer, so it is a bare file
 * name or nothing.
 */
const relaySender = (signedBody: Record<string, unknown>) => ({
  fromUsername: peerString(signedBody.fromUsername, MAX_PEER_NAME_LENGTH),
  fromPublicId: signedBody.fromPublicId,
  fromUserId: peerInteger(signedBody.fromUserId, { min: 1, max: MAX_PEER_USER_ID }),
  fromAvatarFile: peerFileName(signedBody.fromAvatarFile)
});

/** A user whose home is this instance, by publicId. */
const findLocalUserByPublicId = async (
  publicId: string
): Promise<{ id: number } | undefined> => {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.publicId, publicId), eq(users.isFederated, false)))
    .limit(1);
  return user;
};

// POST /federation/friend-request — Forward friend request to local user
const federationFriendRequestHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const { fromUsername, fromPublicId, fromUserId, fromAvatarFile } =
    relaySender(signedBody);
  const toPublicId = signedBody.toPublicId;

  if (!fromUsername) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }
  // Require ids — reject requests without them to prevent impersonation
  if (!isPeerPublicId(fromPublicId) || !isPeerPublicId(toPublicId)) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  // 200-ignore an unknown target: the sender already shows the request
  // as sent, and a status code must not reveal who exists here.
  const targetUser = await findLocalUserByPublicId(toPublicId);
  if (!targetUser) {
    return jsonResponse(res, 200, { ignored: 'unknown_recipient' });
  }

  const shadowUser = await findOrCreateShadowUserByPublicId(
    instance.id,
    fromPublicId,
    fromUsername,
    fromUserId
  );

  if (fromAvatarFile) {
    const protocol = getFederationProtocol(fromDomain);
    syncShadowUserAvatar(shadowUser.id, `${protocol}://${fromDomain}/public/${fromAvatarFile}`);
  }

  // Same rule as a local request: a block in either direction means the
  // request never lands and never rings. 200 so the peer's outbox does
  // not retry, and so the block is not disclosed.
  if (await isBlockBetween(shadowUser.id, targetUser.id)) {
    return jsonResponse(res, 200, { ignored: 'blocked' });
  }

  await db.insert(friendRequests).values({
    senderId: shadowUser.id,
    receiverId: targetUser.id,
    status: 'pending',
    createdAt: Date.now()
  }).onConflictDoNothing();

  // Find the request we just created (or the one a retry already made)
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
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const { fromUsername, fromPublicId, fromUserId, fromAvatarFile } =
    relaySender(signedBody);
  const toPublicId = signedBody.toPublicId;

  if (!fromUsername) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }
  if (!isPeerPublicId(fromPublicId) || !isPeerPublicId(toPublicId)) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  const localUser = await findLocalUserByPublicId(toPublicId);
  if (!localUser) {
    return jsonResponse(res, 200, { ignored: 'unknown_recipient' });
  }

  const shadowUser = await findOrCreateShadowUserByPublicId(
    instance.id,
    fromPublicId,
    fromUsername,
    fromUserId
  );

  if (fromAvatarFile) {
    const protocol = getFederationProtocol(fromDomain);
    syncShadowUserAvatar(shadowUser.id, `${protocol}://${fromDomain}/public/${fromAvatarFile}`);
  }

  // Find the pending friend request from localUser -> shadowUser
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
    // Already accepted (peer retry) or never sent — nothing to do, and
    // a retry would not change that.
    return jsonResponse(res, 200, { ignored: 'no_pending_request' });
  }

  await db
    .update(friendRequests)
    .set({ status: 'accepted', updatedAt: Date.now() })
    .where(eq(friendRequests.id, pendingRequest.id));

  await db
    .insert(friendships)
    .values({
      userId: pendingRequest.senderId,
      friendId: pendingRequest.receiverId,
      createdAt: Date.now()
    })
    .onConflictDoNothing();

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
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody } = auth;

  const fromPublicId = signedBody.fromPublicId;
  const toPublicId = signedBody.toPublicId;

  if (!isPeerPublicId(fromPublicId) || !isPeerPublicId(toPublicId)) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  // The shadow must be homed on the AUTHENTICATED instance — a peer can
  // only end friendships on behalf of its own users.
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
  const localUser = await findLocalUserByPublicId(toPublicId);

  if (!shadowUser || !localUser) {
    return jsonResponse(res, 200, { ignored: 'unknown_user' });
  }

  await db
    .delete(friendships)
    .where(
      or(
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

  pubsub.publishFor(localUser.id, ServerEvents.FRIEND_REMOVED, {
    userId: shadowUser.id,
    friendId: localUser.id
  });

  jsonResponse(res, 200, { success: true });
};

// POST /federation/dm-relay — Relay DM message to local user
const federationDmRelayHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res, { limit: 'dmRelay' });
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const { fromUsername, fromPublicId, fromUserId, fromAvatarFile } =
    relaySender(signedBody);
  const toPublicId = signedBody.toPublicId;
  const content = signedBody.content;
  // Phase D / D1 — when set, `content` is base64-encoded Signal
  // ciphertext (PreKeyMessage on first contact, regular message
  // afterwards). The receiving instance never decrypts; it just
  // routes the envelope to the recipient's WS and persists the
  // ciphertext to dmMessages with the e2ee flag set. Optional,
  // defaults false to preserve the pre-Phase-D plaintext behaviour
  // for in-flight v0.2 traffic.
  const isE2ee = signedBody.e2ee === true;
  // Phase D / D2 — populated for group DMs that span instances. The
  // receiving instance looks up its local mirror by this ID instead
  // of the pair key (which is 1:1 only). Null / undefined for 1:1 DMs
  // and same-instance groups.
  const federationGroupId = isPeerPublicId(signedBody.federationGroupId)
    ? signedBody.federationGroupId
    : null;
  // Forward attribution from the peer — a display-name snapshot only
  // (never a user id; see the id-collision convention). Peer-asserted,
  // so bound it like every other peer-supplied string.
  const forwardedFromName =
    peerString(signedBody.forwardedFromName, MAX_PEER_SERVER_NAME_LENGTH) ?? null;
  // The sender's per-relay id. Its outbox delivers at least once: a
  // relay whose ack was lost is sent again with the same id, and the
  // unique index on dm_messages.federation_relay_id lands it once.
  // Older senders omit it and insert normally.
  const relayId = peerString(signedBody.relayId, MAX_RELAY_ID_LENGTH) || null;

  if (!fromUsername || !content) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Same ceiling as a locally sent DM — the 1 MB body cap alone would
  // let a peer grow dm_messages rows 25x past what our own users can.
  if (typeof content !== 'string' || content.length > MAX_MESSAGE_WIRE_LENGTH) {
    return jsonResponse(res, 400, { error: 'Message too long' });
  }

  // Require ids — reject requests without them to prevent impersonation
  if (!isPeerPublicId(fromPublicId) || !isPeerPublicId(toPublicId)) {
    return jsonResponse(res, 400, { error: 'fromPublicId and toPublicId are required' });
  }

  // 200-ignore an unknown recipient: permanent, so the peer's outbox
  // must not retry, and existence is not disclosed by status code.
  const localUser = await findLocalUserByPublicId(toPublicId);
  if (!localUser) {
    return jsonResponse(res, 200, { ignored: 'unknown_recipient' });
  }

  const shadowUser = await findOrCreateShadowUserByPublicId(
    instance.id,
    fromPublicId,
    fromUsername,
    fromUserId
  );

  if (fromAvatarFile) {
    const protocol = getFederationProtocol(fromDomain);
    syncShadowUserAvatar(shadowUser.id, `${protocol}://${fromDomain}/public/${fromAvatarFile}`);
  }

  // The signature proves the PEER sent this, not that our user wants it.
  // A block in either direction drops the message silently — 200 so the
  // sender's outbox does not retry and the block is not disclosed.
  if (await isBlockBetween(shadowUser.id, localUser.id)) {
    return jsonResponse(res, 200, { ignored: 'blocked' });
  }

  let dmChannelId: number;
  let channelCreated = false;

  if (federationGroupId) {
    // The peer must announce the group via /federation/dm-group-create
    // before relaying messages. That announcement is queued ahead of
    // the message in the peer's outbox, so a missing mirror is a
    // retryable ordering gap (409), never a 404 — a 404 would make the
    // peer dead-letter the message as "route unsupported".
    const [mirror] = await db
      .select({ id: dmChannels.id })
      .from(dmChannels)
      .where(eq(dmChannels.federationGroupId, federationGroupId))
      .limit(1);
    if (!mirror) {
      return jsonResponse(res, 409, {
        error: 'Group mirror not found — was the group announced first?'
      });
    }
    // Only a current member may post: a user the peer removed from the
    // group (or never attested into our mirror) still knows the id.
    const [membership] = await db
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(
        and(
          eq(dmChannelMembers.dmChannelId, mirror.id),
          eq(dmChannelMembers.userId, shadowUser.id)
        )
      )
      .limit(1);
    if (!membership) {
      return jsonResponse(res, 200, { ignored: 'not_member' });
    }
    dmChannelId = mirror.id;
  } else {
    const existing = await findDmChannelBetween(shadowUser.id, localUser.id);
    if (existing !== null) {
      dmChannelId = existing;
    } else {
      // First contact is held to the same rule as a local user opening a
      // DM: friends, or a shared server. The shadow has real
      // server_members rows here, so the plain local query is the truth.
      const permitted =
        (await areFriends(shadowUser.id, localUser.id)) ||
        (await sharesServerWith(shadowUser.id, localUser.id));
      if (!permitted) {
        return jsonResponse(res, 200, { ignored: 'not_permitted' });
      }
      // Upsert on the pair key: two first messages crossing between the
      // instances (or a local click racing the relay) land on one row,
      // with the e2ee flag taken from the envelope only on creation.
      const pair = await getOrCreatePairChannel(shadowUser.id, localUser.id, {
        e2ee: isE2ee
      });
      dmChannelId = pair.id;
      channelCreated = pair.created;
    }
  }

  let channelE2eeFlipped = false;
  if (!channelCreated && isE2ee) {
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

  // Notify the recipient about a brand-new channel BEFORE the message
  // event — the client's unread/lastMessage reducers silently no-op for
  // channels missing from its list, so a first DM from a new federated
  // user produced no sidebar entry and no badge until a full refresh.
  // Same event shape as the same-instance getOrCreateChannel publish.
  // Also fires when the channel just became encrypted so the client
  // refreshes the badge + composer state (same-instance
  // `enableEncryption` parity).
  if (channelCreated || channelE2eeFlipped) {
    pubsub.publishFor(localUser.id, ServerEvents.DM_CHANNEL_UPDATE, {
      dmChannelId,
      name: null,
      iconFileId: null
    });
  }

  const [message] = await db
    .insert(dmMessages)
    .values({
      dmChannelId,
      userId: shadowUser.id,
      content,
      e2ee: isE2ee,
      forwardedFromName,
      federationRelayId: relayId,
      createdAt: Date.now()
    })
    .onConflictDoNothing({ target: dmMessages.federationRelayId })
    .returning({ id: dmMessages.id });

  if (!message) {
    // Already delivered: the peer is retrying a relay whose ack it
    // lost. Acknowledge the existing row and do not ring again.
    const [delivered] = await db
      .select({ id: dmMessages.id })
      .from(dmMessages)
      .where(eq(dmMessages.federationRelayId, relayId!))
      .limit(1);
    return jsonResponse(res, 200, {
      success: true,
      duplicate: true,
      messageId: delivered?.id ?? null
    });
  }

  const joined = await getDmMessage(message.id);
  if (joined) {
    pubsub.publishFor(localUser.id, ServerEvents.DM_NEW_MESSAGE, joined);
  }

  jsonResponse(res, 200, { success: true, messageId: message.id });
};

// POST /federation/report-user — a peer forwards a report about one of
// OUR users (filed on the peer against the user's shadow there). The
// report lands in the instance queue with its origin recorded, because
// this instance is the only party that can act on the account.
//
// Wire body (signed): { subjectPublicId, reporterPublicId,
//   serverPublicId: string | null, kind, reason, details: string | null,
//   messageExcerpt: string | null }
const federationReportUserHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const subjectPublicId = signedBody.subjectPublicId;
  const reporterPublicId = signedBody.reporterPublicId;
  const kind = signedBody.kind;
  const reason = signedBody.reason;
  const serverPublicId = isPeerPublicId(signedBody.serverPublicId)
    ? signedBody.serverPublicId
    : null;
  const details = peerString(signedBody.details, MAX_PEER_REPORT_TEXT_LENGTH) || null;
  const messageExcerpt =
    peerString(signedBody.messageExcerpt, MAX_PEER_REPORT_TEXT_LENGTH) || null;

  if (!isPeerPublicId(subjectPublicId) || !isPeerPublicId(reporterPublicId)) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }
  if (typeof kind !== 'string' || !REPORT_KINDS.has(kind)) {
    return jsonResponse(res, 400, { error: 'Invalid kind' });
  }
  if (typeof reason !== 'string' || !REPORT_REASONS.has(reason)) {
    return jsonResponse(res, 400, { error: 'Invalid reason' });
  }

  // The subject must be one of OUR users. 200-ignore unknowns and
  // shadows — a report about a third instance's user is not ours to
  // act on, and a status code must not reveal who exists here.
  const subject = await findLocalUserByPublicId(subjectPublicId);
  if (!subject) {
    return jsonResponse(res, 200, { ignored: 'unknown_subject' });
  }

  // reports.reporter_id is NOT NULL: the reporter is the peer's user,
  // represented here by their shadow (minted nameless if we have never
  // seen them — the queue shows the publicId placeholder).
  const reporter = await findOrCreateShadowUserByPublicId(
    instance.id,
    reporterPublicId,
    ''
  );

  // The peer server the report was filed on has no row here; keep the
  // reference in the free-text details for the instance admin.
  const context = serverPublicId
    ? `Reported on ${fromDomain}, server ${serverPublicId}.`
    : `Reported on ${fromDomain}.`;

  const [row] = await db
    .insert(reports)
    .values({
      kind,
      targetUserId: subject.id,
      reporterId: reporter.id,
      reason,
      details: details ? `${details}\n\n${context}` : context,
      // The excerpt is what the reporter saw on the peer — attested by
      // them, not something this instance can re-read.
      contentSnapshot: messageExcerpt,
      snapshotAttested: messageExcerpt !== null,
      audience: 'instance',
      status: 'open',
      source: `federated:${fromDomain}`,
      createdAt: Date.now()
    })
    .returning({ id: reports.id });

  logger.info(
    '[federation/report-user] report %d from %s about user %d (%s/%s)',
    row!.id,
    sanitizeForLog(fromDomain),
    subject.id,
    kind,
    reason
  );

  jsonResponse(res, 200, { success: true, reportId: row!.id });
};

// POST /federation/unpeer — the peer ended the pairing on its side
// (removed or blocked us, or switched federation off). Mirror it: the
// row goes to `blocked` so nothing is relayed to a peer that will 403
// it, and the shadows (with the DM channels that only existed for
// them) are swept exactly as a local removal would. Idempotent: a row
// that is already blocked just answers 200.
const federationUnpeerHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res, {
    statuses: ['active', 'pending', 'blocked']
  });
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const reason = signedBody.reason;
  if (reason !== 'removed' && reason !== 'blocked') {
    return jsonResponse(res, 400, { error: 'Invalid reason' });
  }

  if (instance.status === 'blocked') {
    return jsonResponse(res, 200, { success: true, alreadyBlocked: true });
  }

  await db
    .update(federationInstances)
    .set({ status: 'blocked', updatedAt: Date.now() })
    .where(eq(federationInstances.id, instance.id));

  const swept = await deleteShadowUsersByInstance(instance.id);
  invalidateCorsCache();

  pubsub.publish(ServerEvents.FEDERATION_INSTANCE_UPDATE, {
    domain: fromDomain,
    status: 'blocked'
  });

  logger.info(
    '[federation/unpeer] %s ended the pairing (%s): %d shadows, %d channels removed',
    sanitizeForLog(fromDomain),
    reason,
    swept.deletedUsers,
    swept.deletedChannels
  );

  jsonResponse(res, 200, { success: true });
};

// POST /federation/key-rotation — the peer replaced its signing key.
// Signed with the key we have pinned (the prologue accepts the current
// key, and the previous one inside the grace window), so the request
// itself proves the old key's holder; the new key is then confirmed by
// an independent fetch of the peer's /federation/info — a stolen old
// key alone cannot move the pin to an attacker's key. The old key keeps
// verifying for 24 h (peerVerificationKeys) so relays the peer signed
// before switching are not refused.
const federationKeyRotationHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const newPublicKey = signedBody.newPublicKey;
  const rotatedAt = peerInteger(signedBody.rotatedAt, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER
  });
  if (!isPeerPublicKey(newPublicKey) || rotatedAt === undefined) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  if (instance.publicKey === newPublicKey) {
    // The peer's outbox retried a push we already applied.
    return jsonResponse(res, 200, { applied: false });
  }

  const remoteInfo = await fetchPeerInfo(fromDomain);
  if (!remoteInfo) {
    // Retryable: the peer's outbox tries again once it is reachable.
    return jsonResponse(res, 502, {
      error: 'Could not confirm the new key at the peer'
    });
  }
  if (remoteInfo.publicKey !== newPublicKey) {
    logger.warn(
      '[federation/key-rotation] %s announced a key it does not advertise — refused',
      sanitizeForLog(fromDomain)
    );
    return jsonResponse(res, 403, {
      error: 'Announced key does not match the key served by the peer'
    });
  }

  await db
    .update(federationInstances)
    .set({
      previousPublicKey: instance.publicKey,
      publicKey: newPublicKey,
      keyRotatedAt: Date.now(),
      lastSeenAt: Date.now(),
      updatedAt: Date.now()
    })
    .where(eq(federationInstances.id, instance.id));

  logger.info(
    '[federation/key-rotation] re-pinned %s (peer rotated at %d)',
    sanitizeForLog(fromDomain),
    rotatedAt
  );

  jsonResponse(res, 200, { applied: true });
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
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { signedBody, fromDomain } = auth;

  const targetPublicId = signedBody.targetPublicId;
  if (!isPeerPublicId(targetPublicId)) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
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
  federationKeyRotationHandler,
  federationReportUserHandler,
  federationRequestHandler,
  federationServersHandler,
  federationUnpeerHandler,
  federationUserInfoHandler
};
