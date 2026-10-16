import chalk from 'chalk';
import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import { db } from '../db';
import { federationKeys, federationSeenJti } from '../db/schema';
import { logger } from '../logger';
import { FEDERATION_KEY_GRACE_MS } from '../utils/federation';

// Rows deleted per statement — same reasoning as retention.ts: a small
// lock footprint per DELETE and the single Bun thread yields between
// batches on an instance that has never swept.
const BATCH_SIZE = 1000;

/**
 * Sweeps the federation replay cache and retired signing keys.
 *
 * `federation_seen_jti` holds every accepted challenge jti until the
 * signature's own expiry plus the clock tolerance; past that the
 * signature cannot verify, so the row no longer protects anything and
 * only costs index space on a busy pairing. Retired `federation_keys`
 * rows go once their grace window has passed — until then a peer that
 * has not applied our rotation may still check a response we signed
 * with the old key.
 *
 * Returns the number of rows removed from each table.
 */
const pruneFederationReplayState = async (): Promise<{
  jtis: number;
  keys: number;
}> => {
  const now = Date.now();
  let jtis = 0;

  for (;;) {
    const expired = db
      .select({ jti: federationSeenJti.jti })
      .from(federationSeenJti)
      .where(lt(federationSeenJti.expiresAt, now))
      .orderBy(federationSeenJti.jti)
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(federationSeenJti)
      .where(inArray(federationSeenJti.jti, expired))
      .returning({ jti: federationSeenJti.jti });

    jtis += deleted.length;
    if (deleted.length < BATCH_SIZE) break;
  }

  const retiredKeys = await db
    .delete(federationKeys)
    .where(
      and(
        isNotNull(federationKeys.retiredAt),
        lt(federationKeys.retiredAt, now - FEDERATION_KEY_GRACE_MS)
      )
    )
    .returning({ id: federationKeys.id });

  const summary = `Federation: removed ${jtis} expired jti row(s) and ${retiredKeys.length} retired key(s).`;
  if (jtis > 0 || retiredKeys.length > 0) {
    logger.info(`${chalk.dim('[Cron]')} ${summary}`);
  } else {
    logger.debug(`${chalk.dim('[Cron]')} ${summary}`);
  }

  return { jtis, keys: retiredKeys.length };
};

export { pruneFederationReplayState };
