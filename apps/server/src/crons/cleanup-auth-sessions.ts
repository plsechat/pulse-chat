import chalk from 'chalk';
import { inArray, lt } from 'drizzle-orm';
import { db } from '../db';
import { localAuthSessions } from '../db/schema';
import { logger } from '../logger';

// Rows deleted per statement — same reasoning as retention.ts: small
// lock footprint per DELETE and the single Bun thread yields between
// batches on an instance that has never swept.
const BATCH_SIZE = 1000;

/**
 * Deletes `local_auth_sessions` rows whose refresh token has expired.
 * Every refresh token leaves a row behind (rotated ones stay revoked so
 * a replay can be told apart from a never-issued token), so the table
 * grows with sign-ins and refreshes until this sweep. Revoked rows that
 * have not expired yet are kept for exactly that reuse detection.
 *
 * Returns the number of rows removed.
 */
const cleanupExpiredAuthSessions = async (): Promise<number> => {
  const cutoff = Date.now();
  let removed = 0;

  for (;;) {
    const expired = db
      .select({ id: localAuthSessions.id })
      .from(localAuthSessions)
      .where(lt(localAuthSessions.expiresAt, cutoff))
      .orderBy(localAuthSessions.id)
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(localAuthSessions)
      .where(inArray(localAuthSessions.id, expired))
      .returning({ id: localAuthSessions.id });

    removed += deleted.length;
    if (deleted.length < BATCH_SIZE) break;
  }

  const summary = `Auth sessions: removed ${removed} expired row(s).`;
  if (removed > 0) {
    logger.info(`${chalk.dim('[Cron]')} ${summary}`);
  } else {
    logger.debug(`${chalk.dim('[Cron]')} ${summary}`);
  }

  return removed;
};

export { cleanupExpiredAuthSessions };
