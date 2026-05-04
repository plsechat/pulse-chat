/**
 * Phase E / E2 — federation route for cross-instance DM channel state
 * propagation.
 *
 * Today, toggling `e2ee` (or any other channel-level state) on a
 * federated DM updates the local `dm_channels` row and pubsubs
 * locally — but the peer instance's mirror row stays out of date
 * until the next encrypted message arrives and the auto-upgrade
 * path at `dms/send-message.ts:165-167` flips it. The user sees a
 * confusing window in which one side has the lock badge and the
 * other doesn't.
 *
 * This handler propagates state changes in real-time. Body shape
 * (additive — receivers ignore unknown change fields):
 *
 *   {
 *     fromDomain: string                 // signed
 *     toDomain: string                   // audience
 *     // Channel identifier — exactly one of:
 *     federationGroupId?: string         // group DMs
 *     fromPublicId?: string              // 1:1 (sender's publicId)
 *     toPublicId?: string                // 1:1 (recipient's publicId on receiver)
 *     // Changes (at least one required):
 *     e2ee?: boolean
 *   }
 */

import { ServerEvents } from '@pulse/shared';
import { and, eq } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { dmChannelMembers, dmChannels, users } from '../db/schema';
import { logger } from '../logger';
import { pubsub } from '../utils/pubsub';
import { signedJsonResponse } from '../utils/federation';
import {
  authorizeFederationRequest,
  jsonResponse
} from './federation-helpers';

/**
 * Find the 1:1 DM channel between two specific users. Returns the
 * channelId or null. Group channels are excluded — federationGroupId
 * is the addressing model for those.
 */
async function findOneToOneDmChannel(
  userIdA: number,
  userIdB: number
): Promise<number | null> {
  const aRows = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .innerJoin(dmChannels, eq(dmChannels.id, dmChannelMembers.dmChannelId))
    .where(
      and(
        eq(dmChannelMembers.userId, userIdA),
        eq(dmChannels.isGroup, false)
      )
    );
  if (aRows.length === 0) return null;

  const aSet = new Set(aRows.map((r) => r.dmChannelId));

  const bRows = await db
    .select({ dmChannelId: dmChannelMembers.dmChannelId })
    .from(dmChannelMembers)
    .innerJoin(dmChannels, eq(dmChannels.id, dmChannelMembers.dmChannelId))
    .where(
      and(
        eq(dmChannelMembers.userId, userIdB),
        eq(dmChannels.isGroup, false)
      )
    );

  for (const r of bRows) {
    if (aSet.has(r.dmChannelId)) return r.dmChannelId;
  }
  return null;
}

const federationDmChannelStateUpdateHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const auth = await authorizeFederationRequest(req, res);
  if (!auth) return;
  const { instance, signedBody, fromDomain } = auth;

  const federationGroupId = signedBody.federationGroupId as string | undefined;
  const fromPublicId = signedBody.fromPublicId as string | undefined;
  const toPublicId = signedBody.toPublicId as string | undefined;
  const e2eeChange = signedBody.e2ee as boolean | undefined;

  // Validate channel identifier — exactly one of the two paths.
  const hasGroupId = typeof federationGroupId === 'string' && federationGroupId.length > 0;
  const hasOneToOne =
    typeof fromPublicId === 'string' &&
    fromPublicId.length > 0 &&
    typeof toPublicId === 'string' &&
    toPublicId.length > 0;

  if (hasGroupId === hasOneToOne) {
    return jsonResponse(res, 400, {
      error:
        'Provide exactly one channel identifier: federationGroupId, or fromPublicId+toPublicId'
    });
  }

  // Validate at least one change is requested.
  if (typeof e2eeChange !== 'boolean') {
    return jsonResponse(res, 400, { error: 'No changes specified' });
  }

  // Resolve mirror channel.
  let mirrorChannelId: number | null = null;

  if (hasGroupId) {
    const [row] = await db
      .select({ id: dmChannels.id })
      .from(dmChannels)
      .where(eq(dmChannels.federationGroupId, federationGroupId!))
      .limit(1);
    mirrorChannelId = row?.id ?? null;
  } else {
    const [localUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.publicId, toPublicId!))
      .limit(1);
    if (!localUser) {
      // Idempotent-friendly: silently 200 rather than 404 so the
      // sender's dispatcher doesn't repeatedly retry. Log it for
      // observability — it almost always means the recipient
      // doesn't exist on this instance.
      logger.warn(
        '[dm-channel-state-update] no local user for toPublicId, ignoring'
      );
      return signedJsonResponse(res, 200, { ignored: 'unknown_recipient' }, fromDomain);
    }

    const [shadowUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.federatedInstanceId, instance.id),
          eq(users.federatedPublicId, fromPublicId!)
        )
      )
      .limit(1);
    if (!shadowUser) {
      logger.warn(
        '[dm-channel-state-update] no shadow user for fromPublicId, ignoring'
      );
      return signedJsonResponse(res, 200, { ignored: 'unknown_sender' }, fromDomain);
    }

    mirrorChannelId = await findOneToOneDmChannel(localUser.id, shadowUser.id);
  }

  if (mirrorChannelId === null) {
    // Mirror doesn't exist yet (first contact, or asymmetric state).
    // 200 keeps the dispatcher idempotent. The first encrypted message
    // arriving via dm-relay will create the mirror with the correct
    // e2ee flag, so no work is lost.
    return signedJsonResponse(res, 200, { ignored: 'no_mirror_channel' }, fromDomain);
  }

  // Fetch current state to short-circuit no-op updates.
  const [current] = await db
    .select({
      id: dmChannels.id,
      e2ee: dmChannels.e2ee,
      name: dmChannels.name,
      iconFileId: dmChannels.iconFileId
    })
    .from(dmChannels)
    .where(eq(dmChannels.id, mirrorChannelId))
    .limit(1);

  if (!current) {
    return signedJsonResponse(res, 200, { ignored: 'no_mirror_channel' }, fromDomain);
  }

  if (current.e2ee === e2eeChange) {
    // Idempotent — nothing to do.
    return signedJsonResponse(res, 200, { applied: false }, fromDomain);
  }

  await db
    .update(dmChannels)
    .set({ e2ee: e2eeChange, updatedAt: Date.now() })
    .where(eq(dmChannels.id, mirrorChannelId));

  // Pubsub locally so all members of this mirror channel see the flip
  // in real-time. Mirror payload shape matches the existing
  // `enableEncryptionRoute` output so client subscription handlers
  // stay uniform (they re-fetch channel state on receipt).
  const memberRows = await db
    .select({ userId: dmChannelMembers.userId })
    .from(dmChannelMembers)
    .where(eq(dmChannelMembers.dmChannelId, mirrorChannelId));

  for (const m of memberRows) {
    pubsub.publishFor(m.userId, ServerEvents.DM_CHANNEL_UPDATE, {
      dmChannelId: mirrorChannelId,
      name: current.name,
      iconFileId: current.iconFileId
    });
  }

  return signedJsonResponse(res, 200, { applied: true }, fromDomain);
};

export { federationDmChannelStateUpdateHandler };
