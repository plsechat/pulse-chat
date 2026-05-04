/**
 * Phase D / D2 — federation routes for cross-instance group DMs.
 *
 * Group DMs that span instances need a federation-spanning identifier
 * (`federationGroupId`) because each instance has its own
 * `dm_channels` row for the same logical group, and "find the shared
 * group between users X, Y, Z" doesn't generalise once Y or Z lives
 * on a different instance.
 *
 * The four handlers in this file mirror the lifecycle events that
 * `dms/*` routes handle for same-instance groups:
 *
 *   - dm-group-create: announce a new group + members to a peer
 *   - dm-group-add-member: notify a peer that a member was added
 *   - dm-group-remove-member: notify a peer that a member was removed
 *   - dm-sender-key: relay a per-recipient SKDM (E2EE bootstrap) to
 *     a peer instance, where it lands in the local
 *     dm_e2ee_sender_keys table for the recipient to fetch
 *
 * All four use the same wire-format hardening as existing federation
 * routes (Phase 4 signed-body verification) and respond via D0's
 * `signedJsonResponse` so the requester can authenticate the result
 * past TLS-only protection.
 */

import { ServerEvents } from '@pulse/shared';
import { and, eq, inArray } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import {
  dmChannelMembers,
  dmChannels,
  dmE2eeSenderKeys,
  federationInstances,
  users
} from '../db/schema';
import { config } from '../config';
import { findOrCreateShadowUser } from '../db/mutations/federation';
import { logger } from '../logger';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { pubsub } from '../utils/pubsub';
import { signedJsonResponse, verifyChallenge } from '../utils/federation';

type IncomingFederatedMember = {
  publicId: string;
  instanceDomain: string;
  name: string;
  avatarFile?: string | null;
};

const MAX_BODY_SIZE = 1024 * 1024;

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

/**
 * Common request prologue: enabled-check, parse body, look up the
 * sender instance by `fromDomain`, verify the request signature.
 * Returns `{ instance, signedBody, fromDomain }` on success or sends
 * a 4xx and returns null.
 */
async function authorizeFederationRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<
  | {
      instance: { id: number; publicKey: string; domain: string };
      signedBody: Record<string, unknown>;
      fromDomain: string;
    }
  | null
> {
  if (!config.federation.enabled) {
    jsonResponse(res, 403, { error: 'Federation not enabled' });
    return null;
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;

  if (!fromDomain || !signature || typeof signature !== 'string') {
    jsonResponse(res, 400, { error: 'Missing fromDomain or signature' });
    return null;
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
    jsonResponse(res, 403, { error: 'Not a trusted instance' });
    return null;
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    jsonResponse(res, 401, { error: 'Invalid signature' });
    return null;
  }

  return {
    instance: {
      id: instance.id,
      publicKey: instance.publicKey,
      domain: instance.domain
    },
    signedBody,
    fromDomain
  };
}

/**
 * Resolve a member descriptor to a local user id. Three cases:
 *   1. Member's instanceDomain == our domain → find the local user
 *      by publicId. Must already exist.
 *   2. Member's instanceDomain == requesting peer's domain → use
 *      `findOrCreateShadowUser` against that peer's instance row.
 *   3. Member's instanceDomain is neither ours nor the requester's
 *      → look up the third instance in our federationInstances
 *      table; if active, create a shadow against it. If we don't
 *      know the instance, return null (best-effort: this member
 *      simply won't appear in our local mirror; messages routed
 *      through them will fall back to the requesting peer being
 *      able to see them).
 */
async function resolveMemberToLocalUserId(
  member: IncomingFederatedMember,
  requesterInstanceId: number,
  requesterDomain: string
): Promise<number | null> {
  if (member.instanceDomain === config.federation.domain) {
    const [localUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.publicId, member.publicId))
      .limit(1);
    return localUser?.id ?? null;
  }

  let instanceId: number;
  if (member.instanceDomain === requesterDomain) {
    instanceId = requesterInstanceId;
  } else {
    const [otherInstance] = await db
      .select({ id: federationInstances.id, status: federationInstances.status })
      .from(federationInstances)
      .where(eq(federationInstances.domain, member.instanceDomain))
      .limit(1);
    if (!otherInstance || otherInstance.status !== 'active') {
      logger.warn(
        '[dm-group-create] skipping member from unfederated peer %s',
        sanitizeForLog(member.instanceDomain)
      );
      return null;
    }
    instanceId = otherInstance.id;
  }

  const shadow = await findOrCreateShadowUser(
    instanceId,
    0,
    member.name,
    undefined,
    member.publicId
  );
  return shadow.id;
}

// POST /federation/dm-group-create — receiver creates a local mirror
// of the federated group identified by `federationGroupId`.
const federationDmGroupCreateHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const federationGroupId = signedBody.federationGroupId as string;
  const name = (signedBody.name as string | null) ?? null;
  const ownerPublicId = signedBody.ownerPublicId as string;
  const members = signedBody.members as IncomingFederatedMember[];

  if (
    !federationGroupId ||
    !ownerPublicId ||
    !Array.isArray(members) ||
    members.length === 0
  ) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Idempotent: a re-announce of the same group should be a no-op.
  const [existing] = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .where(eq(dmChannels.federationGroupId, federationGroupId))
    .limit(1);

  if (existing) {
    return signedJsonResponse(res, 200, { alreadyExists: true }, fromDomain);
  }

  // Resolve every member to a local user id (real for our users,
  // shadow for everyone else). Skip ones we can't resolve.
  const memberIds: number[] = [];
  const localRecipientIds: number[] = [];
  let ownerId: number | null = null;

  for (const member of members) {
    const userId = await resolveMemberToLocalUserId(
      member,
      instance.id,
      fromDomain
    );
    if (userId === null) continue;
    memberIds.push(userId);
    if (member.publicId === ownerPublicId) {
      ownerId = userId;
    }
    if (member.instanceDomain === config.federation.domain) {
      localRecipientIds.push(userId);
    }
  }

  // We need at least one local member to bother creating the mirror —
  // the whole point of mirroring is so our users can participate.
  if (localRecipientIds.length === 0) {
    return jsonResponse(res, 404, {
      error: 'No local members in announced group'
    });
  }

  const now = Date.now();
  const [newChannel] = await db
    .insert(dmChannels)
    .values({
      name,
      ownerId,
      isGroup: true,
      federationGroupId,
      createdAt: now
    })
    .returning();

  await db.insert(dmChannelMembers).values(
    memberIds.map((userId) => ({
      dmChannelId: newChannel!.id,
      userId,
      createdAt: now
    }))
  );

  for (const userId of localRecipientIds) {
    pubsub.publishFor(userId, ServerEvents.DM_CHANNEL_UPDATE, {
      dmChannelId: newChannel!.id,
      name,
      iconFileId: null
    });
  }

  return signedJsonResponse(
    res,
    200,
    { dmChannelId: newChannel!.id },
    fromDomain
  );
};

// POST /federation/dm-group-add-member — receiver adds the announced
// member to the local mirror of the federated group.
const federationDmGroupAddMemberHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const federationGroupId = signedBody.federationGroupId as string;
  const addedMember = signedBody.addedMember as
    | IncomingFederatedMember
    | undefined;

  if (!federationGroupId || !addedMember?.publicId) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  const [mirror] = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .where(eq(dmChannels.federationGroupId, federationGroupId))
    .limit(1);

  if (!mirror) {
    return jsonResponse(res, 404, { error: 'Group mirror not found' });
  }

  const userId = await resolveMemberToLocalUserId(
    addedMember,
    instance.id,
    fromDomain
  );

  if (userId === null) {
    // Best-effort: silently accept the add of a user we can't
    // resolve (e.g. unfederated third-instance member). The message
    // path will simply not surface their messages locally, which is
    // the same as before.
    return signedJsonResponse(res, 200, { skipped: true }, fromDomain);
  }

  // Idempotent: re-add of an existing member is a no-op.
  const existingMembership = await db
    .select({ userId: dmChannelMembers.userId })
    .from(dmChannelMembers)
    .where(
      and(
        eq(dmChannelMembers.dmChannelId, mirror.id),
        eq(dmChannelMembers.userId, userId)
      )
    )
    .limit(1);

  if (existingMembership.length === 0) {
    await db.insert(dmChannelMembers).values({
      dmChannelId: mirror.id,
      userId,
      createdAt: Date.now()
    });
  }

  // Notify all local members
  const allMembers = await db
    .select({ userId: dmChannelMembers.userId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.dmChannelId, mirror.id));

  for (const m of allMembers) {
    pubsub.publishFor(m.userId, ServerEvents.DM_MEMBER_ADD, {
      dmChannelId: mirror.id,
      userId
    });
  }

  return signedJsonResponse(res, 200, { dmChannelId: mirror.id }, fromDomain);
};

// POST /federation/dm-group-remove-member — receiver removes the
// announced member from the local mirror.
const federationDmGroupRemoveMemberHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { signedBody, fromDomain } = auth;

  const federationGroupId = signedBody.federationGroupId as string;
  const removedPublicId = signedBody.removedPublicId as string;

  if (!federationGroupId || !removedPublicId) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  const [mirror] = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .where(eq(dmChannels.federationGroupId, federationGroupId))
    .limit(1);

  if (!mirror) {
    return jsonResponse(res, 404, { error: 'Group mirror not found' });
  }

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, removedPublicId))
    .limit(1);

  if (!user) {
    // Already gone or never resolved locally — idempotent success.
    return signedJsonResponse(res, 200, { skipped: true }, fromDomain);
  }

  const allMembersBeforeDelete = await db
    .select({ userId: dmChannelMembers.userId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.dmChannelId, mirror.id));

  await db
    .delete(dmChannelMembers)
    .where(
      and(
        eq(dmChannelMembers.dmChannelId, mirror.id),
        eq(dmChannelMembers.userId, user.id)
      )
    );

  for (const m of allMembersBeforeDelete) {
    pubsub.publishFor(m.userId, ServerEvents.DM_MEMBER_REMOVE, {
      dmChannelId: mirror.id,
      userId: user.id
    });
  }

  return signedJsonResponse(res, 200, { dmChannelId: mirror.id }, fromDomain);
};

// POST /federation/dm-sender-key — receiver records a per-recipient
// SKDM (sender-key distribution message) addressed to one of our
// local users. Mirrors `dms.distributeSenderKeys` writes for the
// federated case.
const federationDmSenderKeyHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const federationGroupId = signedBody.federationGroupId as string;
  const senderKeyId = signedBody.senderKeyId as number;
  const fromPublicId = signedBody.fromPublicId as string;
  const toPublicId = signedBody.toPublicId as string;
  const distributionMessage = signedBody.distributionMessage as string;

  if (
    !federationGroupId ||
    typeof senderKeyId !== 'number' ||
    !fromPublicId ||
    !toPublicId ||
    !distributionMessage
  ) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  const [mirror] = await db
    .select({ id: dmChannels.id })
    .from(dmChannels)
    .where(eq(dmChannels.federationGroupId, federationGroupId))
    .limit(1);

  if (!mirror) {
    return jsonResponse(res, 404, { error: 'Group mirror not found' });
  }

  // Sender lives on the requesting peer's instance; resolve via shadow.
  const shadowSender = await findOrCreateShadowUser(
    instance.id,
    0,
    fromPublicId,
    undefined,
    fromPublicId
  );

  // Recipient must be local.
  const [localRecipient] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.publicId, toPublicId))
    .limit(1);

  if (!localRecipient) {
    return jsonResponse(res, 404, { error: 'Local recipient not found' });
  }

  await db.insert(dmE2eeSenderKeys).values({
    dmChannelId: mirror.id,
    senderKeyId,
    fromUserId: shadowSender.id,
    toUserId: localRecipient.id,
    distributionMessage,
    createdAt: Date.now()
  });

  pubsub.publishFor(
    localRecipient.id,
    ServerEvents.DM_SENDER_KEY_DISTRIBUTION,
    {
      dmChannelId: mirror.id,
      fromUserId: shadowSender.id
    }
  );

  return signedJsonResponse(res, 200, { success: true }, fromDomain);
};

// POST /federation/identity-rotation-broadcast — receiver routes the
// rotation to local users who share an active DM with the rotating
// (federated) user. Phase D / D3.
//
// Reuses the same `E2EE_IDENTITY_RESET` event the same-instance
// rotation uses, so the existing Phase C client handler picks it up
// without changes. The new identity key is embedded in the payload
// so the client doesn't have to round-trip back through federation
// to fetch the bundle just to learn the new key.
const federationIdentityRotationHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const fromPublicId = signedBody.fromPublicId as string;
  const newIdentityPublicKey = signedBody.newIdentityPublicKey as string;

  if (!fromPublicId || !newIdentityPublicKey) {
    return jsonResponse(res, 400, { error: 'Missing required fields' });
  }

  // Find the shadow record we keep for this remote user. If we don't
  // have one, the user has never DM'd anyone here and there's no one
  // to notify — silent no-op.
  const [shadow] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.federatedInstanceId, instance.id),
        eq(users.federatedPublicId, fromPublicId)
      )
    )
    .limit(1);

  if (!shadow) {
    return signedJsonResponse(
      res,
      200,
      { skipped: 'no shadow user' },
      fromDomain
    );
  }

  // Find every local user that shares a DM channel with the shadow
  // user. They're the only ones whose verifiedIdentities pin needs
  // to update.
  const sharedChannels = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.userId, shadow.id));

  if (sharedChannels.length === 0) {
    return signedJsonResponse(
      res,
      200,
      { skipped: 'no shared channels' },
      fromDomain
    );
  }

  const channelIds = sharedChannels.map((c) => c.dmChannelId);
  const localMemberRows = await db
    .selectDistinct({ userId: dmChannelMembers.userId })
    .from(dmChannelMembers)
    .innerJoin(users, eq(users.id, dmChannelMembers.userId))
    .where(
      and(
        inArray(dmChannelMembers.dmChannelId, channelIds),
        eq(users.isFederated, false)
      )
    );

  if (localMemberRows.length === 0) {
    return signedJsonResponse(
      res,
      200,
      { skipped: 'no local recipients' },
      fromDomain
    );
  }

  pubsub.publishFor(
    localMemberRows.map((r) => r.userId),
    ServerEvents.E2EE_IDENTITY_RESET,
    {
      userId: shadow.id,
      newIdentityPublicKey
    }
  );

  return signedJsonResponse(
    res,
    200,
    { notified: localMemberRows.length },
    fromDomain
  );
};

export {
  federationDmGroupAddMemberHandler,
  federationDmGroupCreateHandler,
  federationDmGroupRemoveMemberHandler,
  federationDmSenderKeyHandler,
  federationIdentityRotationHandler
};
