import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { federationInstances } from '../../db/schema';
import { logger } from '../../logger';
import { rotateLocalFederationKeys } from '../../utils/federation';
import { enqueueRelayDetailed } from '../../utils/federation-outbox';
import { instanceOwnerProcedure } from '../../utils/procedures';

// Instance-owner gated like every other instance-federation surface
// (generate-keys.ts). Rotating replaces the key every peer has pinned,
// so it is the one operation that can cut this instance off from its
// peers if misused.
//
// The announcement to each peer goes through the outbox, signed with the
// OLD key: it is the only key the peer has pinned, so a push under the
// new key would be refused as a forgery. The receiver verifies with that
// pinned key and then re-fetches our /federation/info as a second factor
// before replacing the pin. A peer that is down receives the push when
// the outbox reaches it (the retired key stays usable for 24 h); a 404
// means the peer predates the route and is dead-lettered at once.
const rotateKeysRoute = instanceOwnerProcedure.mutation(async () => {
  const { previous, next } = await rotateLocalFederationKeys();
  const rotatedAt = Date.now();
  const newPublicKey = JSON.stringify(next.publicKey);

  logger.info(
    '[federation/rotateKeys] key %d retired, key %d is live',
    previous.id,
    next.id
  );

  const peers = await db
    .select({ domain: federationInstances.domain })
    .from(federationInstances)
    .where(eq(federationInstances.status, 'active'));

  const notified: string[] = [];
  const failed: string[] = [];
  const unsupported: string[] = [];

  // Sequential on purpose: a fan-out across every peer at once would
  // burst the per-host outbound limiter for nothing.
  for (const peer of peers) {
    const outcome = await enqueueRelayDetailed(
      peer.domain,
      '/federation/key-rotation',
      { newPublicKey, rotatedAt },
      { signingKeys: previous }
    );
    if (outcome.ok) notified.push(peer.domain);
    else if (outcome.unsupported) unsupported.push(peer.domain);
    // Queued: the outbox keeps trying on its schedule.
    else failed.push(peer.domain);
  }

  return { publicKey: newPublicKey, rotatedAt, notified, failed, unsupported };
});

export { rotateKeysRoute };
