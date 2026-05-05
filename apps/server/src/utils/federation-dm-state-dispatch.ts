/**
 * Phase E / E2 — server-side dispatchers that relay DM channel state
 * changes (currently `e2ee`, future-extensible) to peer instances.
 *
 * Called from DM mutations after the local DB write succeeds; a
 * failed relay is logged and does not roll back the local write
 * (best-effort federation, same as existing dm-relay and the Phase D
 * dispatchers).
 *
 * Symmetry with `federation-dm-group-dispatch.ts`:
 *   - Group DMs use `federationGroupId` for channel identity
 *   - 1:1 DMs use the (fromPublicId, toPublicId) pair — there's no
 *     federationGroupId for 1:1s, and the receiver finds its own
 *     mirror by looking up its local user (toPublicId) and shadow
 *     user (fromPublicId on the sender's instance)
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import {
  dmChannelMembers,
  dmChannels,
  federationInstances,
  users
} from '../db/schema';
import { logger } from '../logger';
import { relayToInstance } from './federation';

type StateChanges = {
  e2ee?: boolean;
};

/**
 * Relay a DM channel state change (e.g. e2ee flag flip) to every peer
 * instance with a member in the channel. Fire-and-forget per peer; one
 * failure doesn't block siblings.
 *
 * `senderUserId` is the local user who initiated the change — used to
 * compute the `fromPublicId` for 1:1 DMs (peer instances need to know
 * which side of the conversation triggered the change).
 */
async function relayFederatedDmChannelStateUpdate(
  dmChannelId: number,
  senderUserId: number,
  changes: StateChanges
): Promise<void> {
  if (Object.keys(changes).length === 0) return;

  const [channel] = await db
    .select({
      id: dmChannels.id,
      isGroup: dmChannels.isGroup,
      federationGroupId: dmChannels.federationGroupId
    })
    .from(dmChannels)
    .where(eq(dmChannels.id, dmChannelId))
    .limit(1);
  if (!channel) return;

  // Pull every member with the federation metadata we need to address
  // them on their home instance.
  const memberRows = await db
    .select({
      userId: users.id,
      publicId: users.publicId,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedPublicId: users.federatedPublicId
    })
    .from(dmChannelMembers)
    .innerJoin(users, eq(users.id, dmChannelMembers.userId))
    .where(eq(dmChannelMembers.dmChannelId, dmChannelId));

  // Find the sender's publicId (the one peer instances will look up
  // as the shadow user). For local sender it's the local publicId.
  const senderRow = memberRows.find((m) => m.userId === senderUserId);
  if (!senderRow?.publicId) {
    logger.warn(
      '[relayFederatedDmChannelStateUpdate] sender %s missing publicId',
      senderUserId
    );
    return;
  }
  const fromPublicId = senderRow.publicId;

  // Distinct federated peer instance ids for this channel (excluding
  // the sender themselves if they happen to be federated — we don't
  // re-send the change to the originating instance).
  const federatedInstanceIds = Array.from(
    new Set(
      memberRows
        .filter(
          (m) =>
            m.isFederated &&
            m.federatedInstanceId &&
            m.userId !== senderUserId
        )
        .map((m) => m.federatedInstanceId as number)
    )
  );
  if (federatedInstanceIds.length === 0) return;

  // Resolve those peer ids to domains.
  const instances = await db
    .select({
      id: federationInstances.id,
      domain: federationInstances.domain
    })
    .from(federationInstances)
    .where(inArray(federationInstances.id, federatedInstanceIds));
  const domainById = new Map(instances.map((i) => [i.id, i.domain]));

  // For 1:1s we need each peer's recipient publicId (the federated
  // member's `federatedPublicId` — i.e. that user's publicId on their
  // home instance). For groups we pass federationGroupId and skip the
  // per-recipient publicId since the receiver resolves by group id.
  const isGroup = channel.isGroup;
  const federationGroupId = channel.federationGroupId;

  if (isGroup) {
    if (!federationGroupId) {
      logger.warn(
        '[relayFederatedDmChannelStateUpdate] group %s missing federationGroupId — was it ever federated?',
        dmChannelId
      );
      return;
    }
    for (const instanceId of federatedInstanceIds) {
      const domain = domainById.get(instanceId);
      if (!domain) continue;
      relayToInstance(domain, '/federation/dm-channel-state-update', {
        federationGroupId,
        ...changes
      }).catch((err) =>
        logger.error(
          '[relayFederatedDmChannelStateUpdate] relay to %s failed: %o',
          domain,
          err
        )
      );
    }
    return;
  }

  // 1:1 — one peer, one recipient publicId.
  const peerMember = memberRows.find(
    (m) => m.isFederated && m.federatedInstanceId && m.userId !== senderUserId
  );
  if (!peerMember?.federatedPublicId || !peerMember.federatedInstanceId) {
    return;
  }
  const peerDomain = domainById.get(peerMember.federatedInstanceId);
  if (!peerDomain) return;

  relayToInstance(peerDomain, '/federation/dm-channel-state-update', {
    fromPublicId,
    toPublicId: peerMember.federatedPublicId,
    ...changes
  }).catch((err) =>
    logger.error(
      '[relayFederatedDmChannelStateUpdate] relay to %s failed: %o',
      peerDomain,
      err
    )
  );
}

export { relayFederatedDmChannelStateUpdate };
