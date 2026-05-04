/**
 * Phase D / D2 — server-side dispatchers that relay group DM
 * lifecycle events to peer instances. Called from `dms/*` mutations
 * after the local DB write succeeds; a failed relay is logged and
 * does not roll back the local write (best-effort federation, same
 * as existing dm-relay).
 *
 * Each helper resolves the set of peer instances involved (one per
 * unique `federatedInstanceId` among the channel's members) and
 * fires a signed POST per peer. The peer's mirror channel is keyed
 * on `federationGroupId`, populated locally via either:
 *   - `assignFederationGroupIdIfNeeded` on group create / 1:1→group
 *     promotion when any member is federated
 *   - inbound `/federation/dm-group-create` for groups originating
 *     on a peer
 */

import { randomUUIDv7 } from 'bun';
import { eq, inArray, and } from 'drizzle-orm';
import { db } from '../db';
import {
  dmChannelMembers,
  dmChannels,
  federationInstances,
  users
} from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';
import { relayToInstance } from './federation';

type FederatedMember = {
  publicId: string;
  instanceDomain: string;
  name: string;
};

type LocalMember = {
  publicId: string;
  name: string;
};

type ResolvedMember = FederatedMember | (LocalMember & {
  instanceDomain: string; // == config.federation.domain for local
});

/**
 * Build the wire-shape member list for a channel: every member with
 * publicId, the instance domain they live on (our own domain for
 * local users, their home domain for federated ones), and a display
 * name. Skips users that have no publicId — we shouldn't be
 * federating those, and the dm-relay path already requires publicId.
 */
async function buildFederatedMemberList(
  dmChannelId: number
): Promise<{
  members: ResolvedMember[];
  byUserId: Map<number, ResolvedMember>;
  peerDomains: Set<string>;
}> {
  const memberRows = await db
    .select({
      userId: users.id,
      publicId: users.publicId,
      name: users.name,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedPublicId: users.federatedPublicId
    })
    .from(dmChannelMembers)
    .innerJoin(users, eq(users.id, dmChannelMembers.userId))
    .where(eq(dmChannelMembers.dmChannelId, dmChannelId));

  // Resolve federated user instance domains in one batch
  const federatedInstanceIds = Array.from(
    new Set(
      memberRows
        .filter((m) => m.isFederated && m.federatedInstanceId)
        .map((m) => m.federatedInstanceId as number)
    )
  );

  const instanceDomainById = new Map<number, string>();
  if (federatedInstanceIds.length > 0) {
    const rows = await db
      .select({
        id: federationInstances.id,
        domain: federationInstances.domain
      })
      .from(federationInstances)
      .where(inArray(federationInstances.id, federatedInstanceIds));
    for (const r of rows) instanceDomainById.set(r.id, r.domain);
  }

  const members: ResolvedMember[] = [];
  const byUserId = new Map<number, ResolvedMember>();
  const peerDomains = new Set<string>();

  for (const row of memberRows) {
    if (!row.publicId) continue;

    let publicId: string;
    let domain: string;
    if (row.isFederated && row.federatedInstanceId) {
      const inst = instanceDomainById.get(row.federatedInstanceId);
      if (!inst) continue;
      publicId = row.federatedPublicId ?? row.publicId;
      domain = inst;
      peerDomains.add(domain);
    } else {
      publicId = row.publicId;
      domain = config.federation.domain;
    }

    const m: ResolvedMember = {
      publicId,
      instanceDomain: domain,
      name: row.name
    };
    members.push(m);
    byUserId.set(row.userId, m);
  }

  return { members, byUserId, peerDomains };
}

/**
 * If the channel includes any federated member and doesn't yet have
 * a `federationGroupId`, generate and assign one. Returns the value
 * (existing or new) or null if the channel has no federated members.
 *
 * Called from createGroup and from the 1:1→group promotion path so
 * the assignment happens before any relay.
 */
async function assignFederationGroupIdIfNeeded(
  dmChannelId: number
): Promise<string | null> {
  const [channel] = await db
    .select({
      id: dmChannels.id,
      isGroup: dmChannels.isGroup,
      federationGroupId: dmChannels.federationGroupId
    })
    .from(dmChannels)
    .where(eq(dmChannels.id, dmChannelId))
    .limit(1);

  if (!channel || !channel.isGroup) return null;
  if (channel.federationGroupId) return channel.federationGroupId;

  const hasFederated = await db
    .select({ id: users.id })
    .from(dmChannelMembers)
    .innerJoin(users, eq(users.id, dmChannelMembers.userId))
    .where(
      and(
        eq(dmChannelMembers.dmChannelId, dmChannelId),
        eq(users.isFederated, true)
      )
    )
    .limit(1);

  if (hasFederated.length === 0) return null;

  const federationGroupId = randomUUIDv7();
  await db
    .update(dmChannels)
    .set({ federationGroupId, updatedAt: Date.now() })
    .where(eq(dmChannels.id, dmChannelId));
  return federationGroupId;
}

/**
 * Announce the group + members to every peer instance involved.
 * Fire-and-forget per peer; one failure doesn't block others.
 */
async function announceFederatedGroupCreate(
  dmChannelId: number,
  ownerUserId: number | null
): Promise<void> {
  const [channel] = await db
    .select({
      federationGroupId: dmChannels.federationGroupId,
      name: dmChannels.name
    })
    .from(dmChannels)
    .where(eq(dmChannels.id, dmChannelId))
    .limit(1);
  if (!channel?.federationGroupId) return;

  const { members, byUserId, peerDomains } =
    await buildFederatedMemberList(dmChannelId);
  if (peerDomains.size === 0) return;

  const ownerMember =
    ownerUserId !== null ? byUserId.get(ownerUserId) : undefined;
  if (!ownerMember) {
    logger.warn(
      '[announceFederatedGroupCreate] owner %s missing from members',
      ownerUserId
    );
    return;
  }

  for (const peerDomain of peerDomains) {
    relayToInstance(peerDomain, '/federation/dm-group-create', {
      federationGroupId: channel.federationGroupId,
      name: channel.name,
      ownerPublicId: ownerMember.publicId,
      members
    }).catch((err) =>
      logger.error(
        '[announceFederatedGroupCreate] relay to %s failed: %o',
        peerDomain,
        err
      )
    );
  }
}

/**
 * Notify every peer instance that a member was added.
 */
async function announceFederatedGroupAddMember(
  dmChannelId: number,
  addedUserId: number
): Promise<void> {
  const [channel] = await db
    .select({ federationGroupId: dmChannels.federationGroupId })
    .from(dmChannels)
    .where(eq(dmChannels.id, dmChannelId))
    .limit(1);
  if (!channel?.federationGroupId) return;

  const [addedRow] = await db
    .select({
      publicId: users.publicId,
      name: users.name,
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedPublicId: users.federatedPublicId
    })
    .from(users)
    .where(eq(users.id, addedUserId))
    .limit(1);
  if (!addedRow?.publicId) return;

  let addedDomain = config.federation.domain;
  let addedPublicId = addedRow.publicId;
  if (addedRow.isFederated && addedRow.federatedInstanceId) {
    const [inst] = await db
      .select({ domain: federationInstances.domain })
      .from(federationInstances)
      .where(eq(federationInstances.id, addedRow.federatedInstanceId))
      .limit(1);
    if (!inst) return;
    addedDomain = inst.domain;
    addedPublicId = addedRow.federatedPublicId ?? addedPublicId;
  }

  const { peerDomains } = await buildFederatedMemberList(dmChannelId);
  // Don't echo the announcement back to the added user's own instance —
  // they originate the membership over there independently.
  peerDomains.delete(addedDomain);
  if (peerDomains.size === 0) return;

  for (const peerDomain of peerDomains) {
    relayToInstance(peerDomain, '/federation/dm-group-add-member', {
      federationGroupId: channel.federationGroupId,
      addedMember: {
        publicId: addedPublicId,
        instanceDomain: addedDomain,
        name: addedRow.name
      }
    }).catch((err) =>
      logger.error(
        '[announceFederatedGroupAddMember] relay to %s failed: %o',
        peerDomain,
        err
      )
    );
  }
}

/**
 * Notify every peer instance that a member was removed.
 */
async function announceFederatedGroupRemoveMember(
  dmChannelId: number,
  removedUserId: number,
  // Pass the public-id of the removed user explicitly. Caller already
  // looked it up before deleting from dm_channel_members; recomputing
  // post-delete would require keeping the row alive longer than
  // intended.
  removedPublicId: string
): Promise<void> {
  const [channel] = await db
    .select({ federationGroupId: dmChannels.federationGroupId })
    .from(dmChannels)
    .where(eq(dmChannels.id, dmChannelId))
    .limit(1);
  if (!channel?.federationGroupId) return;

  const { peerDomains } = await buildFederatedMemberList(dmChannelId);
  if (peerDomains.size === 0) return;

  // Use removedUserId for log only — the federation message just
  // carries removedPublicId.
  void removedUserId;

  for (const peerDomain of peerDomains) {
    relayToInstance(peerDomain, '/federation/dm-group-remove-member', {
      federationGroupId: channel.federationGroupId,
      removedPublicId
    }).catch((err) =>
      logger.error(
        '[announceFederatedGroupRemoveMember] relay to %s failed: %o',
        peerDomain,
        err
      )
    );
  }
}

/**
 * Relay a single SKDM (one per recipient) to the recipient's home
 * instance. Caller already validated that `toUser` is federated.
 */
async function relayFederatedSkdm(args: {
  federationGroupId: string;
  senderKeyId: number;
  fromUserId: number;
  toUserId: number;
  distributionMessage: string;
}): Promise<void> {
  const [fromUser] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, args.fromUserId))
    .limit(1);
  if (!fromUser?.publicId) return;

  const [toUser] = await db
    .select({
      isFederated: users.isFederated,
      federatedInstanceId: users.federatedInstanceId,
      federatedPublicId: users.federatedPublicId
    })
    .from(users)
    .where(eq(users.id, args.toUserId))
    .limit(1);
  if (
    !toUser?.isFederated ||
    !toUser.federatedInstanceId ||
    !toUser.federatedPublicId
  ) {
    return;
  }

  const [instance] = await db
    .select({
      domain: federationInstances.domain,
      status: federationInstances.status
    })
    .from(federationInstances)
    .where(eq(federationInstances.id, toUser.federatedInstanceId))
    .limit(1);
  if (!instance || instance.status !== 'active') return;

  await relayToInstance(instance.domain, '/federation/dm-sender-key', {
    federationGroupId: args.federationGroupId,
    senderKeyId: args.senderKeyId,
    fromPublicId: fromUser.publicId,
    toPublicId: toUser.federatedPublicId,
    distributionMessage: args.distributionMessage
  }).catch((err) =>
    logger.error(
      '[relayFederatedSkdm] relay to %s failed: %o',
      instance.domain,
      err
    )
  );
}

/**
 * Get the federation_group_id of a channel (or null if same-instance
 * or not yet assigned). Convenience for callers that just want to
 * include the id in their dm-relay payload.
 */
async function getFederationGroupId(
  dmChannelId: number
): Promise<string | null> {
  const [row] = await db
    .select({ federationGroupId: dmChannels.federationGroupId })
    .from(dmChannels)
    .where(eq(dmChannels.id, dmChannelId))
    .limit(1);
  return row?.federationGroupId ?? null;
}

export {
  announceFederatedGroupAddMember,
  announceFederatedGroupCreate,
  announceFederatedGroupRemoveMember,
  assignFederationGroupIdIfNeeded,
  buildFederatedMemberList,
  getFederationGroupId,
  relayFederatedSkdm
};
