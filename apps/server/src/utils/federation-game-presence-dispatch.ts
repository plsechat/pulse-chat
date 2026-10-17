/**
 * Game presence over federation. A peer that hosts a server our user
 * joined holds a shadow of them, and its roster shows what the shadow
 * is playing only if we say so: the home instance is the one place the
 * preference lives. The push rides the existing presence relay
 * (`/federation/user-info-update`, transient — a presence that failed
 * to reach a peer is superseded by the next one, never queued) and
 * carries, per peer, the presence as the user shares it plus the
 * publicIds of THAT peer's servers the user hid it from. The peer
 * mirrors the list onto the shadow (mirrorShadowPresencePreference) and
 * applies the same per-server rule we do.
 *
 * Peer scope is the user's own federated memberships
 * (user_federated_servers), not the DM-derived scope the profile relay
 * uses: a community the user joined on a peer is exactly where a roster
 * would show the presence.
 */

import { and, eq } from 'drizzle-orm';
import { config } from '../config';
import { db } from '../db';
import { getGamePresenceState } from '../db/queries/game-presence';
import { federationInstances, userFederatedServers, users } from '../db/schema';
import { logger } from '../logger';
import { enqueueRelay } from './federation-outbox';

/** The hidden entries that name servers on `domain`, as that peer's publicIds. */
const hiddenPublicIdsForPeer = (
  hiddenServers: Array<number | string>,
  domain: string
): string[] => {
  const prefix = `${domain}:`;
  return hiddenServers
    .filter((key): key is string => typeof key === 'string' && key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
};

async function relayGamePresence(userId: number): Promise<void> {
  // Guarded as a whole: every call site is fire-and-forget.
  try {
    if (!config.federation.enabled) return;

    const [user] = await db
      .select({ publicId: users.publicId, isFederated: users.isFederated })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    // A shadow's presence is its home instance's to announce.
    if (!user || user.isFederated || !user.publicId) return;

    const peers = await db
      .selectDistinct({ domain: federationInstances.domain })
      .from(userFederatedServers)
      .innerJoin(
        federationInstances,
        eq(userFederatedServers.instanceId, federationInstances.id)
      )
      .where(
        and(
          eq(userFederatedServers.userId, userId),
          eq(federationInstances.status, 'active')
        )
      );
    if (peers.length === 0) return;

    const state = await getGamePresenceState(userId);
    const gamePresence =
      state.presence && state.prefs.shareGame
        ? { name: state.presence.name, startedAt: state.presence.startedAt }
        : null;

    for (const { domain } of peers) {
      enqueueRelay(
        domain,
        '/federation/user-info-update',
        {
          subjectPublicId: user.publicId,
          gamePresence,
          gamePresenceHiddenServers: hiddenPublicIdsForPeer(
            state.prefs.hiddenServers,
            domain
          )
        },
        { transient: true }
      ).catch((err) =>
        logger.error('[relayGamePresence] relay to %s failed: %o', domain, err)
      );
    }
  } catch (err) {
    logger.error('[relayGamePresence] dispatch failed: %o', err);
  }
}

export { hiddenPublicIdsForPeer, relayGamePresence };
