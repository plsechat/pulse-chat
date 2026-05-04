/**
 * Phase E / E1d — server-side dispatcher that notifies peer
 * instances when a sender-key distribution message (SKDM) is
 * available on this host for one of their users.
 *
 * Model is host-only storage (Decision 1, Option A): the SKDM
 * ciphertext lives in this host's `e2ee_sender_keys` table even
 * for federated recipients. The federation event is just a
 * notification — peer client receives it, opens or reuses an
 * active-server tRPC to this host, calls the existing
 * `e2ee.getPendingSenderKeys` route, decrypts, acks.
 *
 * This dispatcher groups federated recipients by peer instance
 * and fires one signed POST per peer — N peers × O(1) requests,
 * not O(recipients).
 */

import { eq, inArray } from 'drizzle-orm';
import { db } from '../db';
import { channels, federationInstances, users } from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';
import { relayToInstance } from './federation';

type FederatedTarget = {
  toPublicId: string;
  toInstanceDomain: string;
};

type RelayArgs = {
  channelId: number;
  fromUserId: number;
  senderKeyId: number;
  targets: FederatedTarget[];
};

/**
 * Notify peer instances that one of their users has a fresh SKDM
 * waiting on this host. Fire-and-forget per peer; one failure
 * doesn't block siblings.
 */
async function relayFederatedChannelSenderKeyNotifications(
  args: RelayArgs
): Promise<void> {
  if (args.targets.length === 0) return;

  const [channel] = await db
    .select({ publicId: channels.publicId })
    .from(channels)
    .where(eq(channels.id, args.channelId))
    .limit(1);

  if (!channel?.publicId) {
    // Channels missing publicId are pre-E1a rows that haven't been
    // backfilled yet, or a channel just created in the same boot
    // before backfill ran. Either way we can't address it across
    // instances without leaking the host-local integer id.
    logger.warn(
      '[relayFederatedChannelSenderKeyNotifications] channel %d missing publicId — skipping',
      args.channelId
    );
    return;
  }
  const hostChannelPublicId = channel.publicId;

  const [sender] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, args.fromUserId))
    .limit(1);
  if (!sender?.publicId) {
    logger.warn(
      '[relayFederatedChannelSenderKeyNotifications] sender %d missing publicId',
      args.fromUserId
    );
    return;
  }
  const fromPublicId = sender.publicId;

  // Drop targets pointing back at our own domain — those are local
  // to this host and don't need a federation hop.
  const externalTargets = args.targets.filter(
    (t) => t.toInstanceDomain !== config.federation.domain
  );
  if (externalTargets.length === 0) return;

  // Group recipient publicIds by peer instance domain.
  const byDomain = new Map<string, string[]>();
  for (const t of externalTargets) {
    const existing = byDomain.get(t.toInstanceDomain);
    if (existing) {
      existing.push(t.toPublicId);
    } else {
      byDomain.set(t.toInstanceDomain, [t.toPublicId]);
    }
  }

  // Confirm those peer domains are active federations before
  // wasting a network call. Active federations only — a paused
  // or revoked peer's notifications stay queued in our SKDM table
  // and reach them when their instance comes back online and they
  // reconnect to fetch.
  const domains = Array.from(byDomain.keys());
  const activeRows = await db
    .select({ domain: federationInstances.domain })
    .from(federationInstances)
    .where(inArray(federationInstances.domain, domains));
  const active = new Set(
    activeRows
      .filter((r): r is { domain: string } => Boolean(r.domain))
      .map((r) => r.domain)
  );

  for (const [domain, recipientPublicIds] of byDomain.entries()) {
    if (!active.has(domain)) {
      logger.warn(
        '[relayFederatedChannelSenderKeyNotifications] inactive peer %s — skipping',
        domain
      );
      continue;
    }

    relayToInstance(domain, '/federation/channel-sender-key-notify', {
      hostDomain: config.federation.domain,
      hostChannelPublicId,
      fromPublicId,
      senderKeyId: args.senderKeyId,
      recipientPublicIds
    }).catch((err) =>
      logger.error(
        '[relayFederatedChannelSenderKeyNotifications] relay to %s failed: %o',
        domain,
        err
      )
    );
  }
}

export { relayFederatedChannelSenderKeyNotifications };
