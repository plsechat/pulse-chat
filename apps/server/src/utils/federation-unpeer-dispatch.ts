/**
 * Tell a peer we are ending the pairing (instance removed, blocked, or
 * federation switched off here) so it stops relaying to us and marks
 * its side instead of discovering the fact from 403s.
 *
 * Best-effort by construction: the peer row is about to be deleted or
 * blocked, so there is nothing to retry against later — this is a
 * transient relay (no outbox row). The caller waits at most
 * `UNPEER_WAIT_MS` before carrying on with the removal; a slow peer
 * still receives the request in the background, a dead one simply
 * does not.
 */

import { logger } from '../logger';
import { enqueueRelay } from './federation-outbox';

const UNPEER_WAIT_MS = 3_000;

type UnpeerReason = 'removed' | 'blocked';

async function relayUnpeer(domain: string, reason: UnpeerReason): Promise<void> {
  const relay = enqueueRelay(
    domain,
    '/federation/unpeer',
    { reason },
    { transient: true }
  ).catch((err) =>
    logger.error('[relayUnpeer] relay to %s failed: %o', domain, err)
  );
  await Promise.race([relay, Bun.sleep(UNPEER_WAIT_MS)]);
}

export { relayUnpeer };
