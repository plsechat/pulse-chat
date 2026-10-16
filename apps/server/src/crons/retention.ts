import chalk from 'chalk';
import { inArray, lt } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { config } from '../config';
import { db } from '../db';
import { activityLog, logins } from '../db/schema';
import { logger } from '../logger';

// Rows deleted per statement. Keeps each DELETE's lock footprint and
// WAL burst small on an instance that has never pruned before (years of
// logins), and yields the single Bun thread between batches.
const BATCH_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pruneTable = async (
  table: PgTable,
  idColumn: PgColumn,
  createdAtColumn: PgColumn,
  cutoff: number
): Promise<number> => {
  let removed = 0;

  for (;;) {
    const expired = db
      .select({ id: idColumn })
      .from(table)
      .where(lt(createdAtColumn, cutoff))
      .orderBy(idColumn)
      .limit(BATCH_SIZE);

    const deleted = await db
      .delete(table)
      .where(inArray(idColumn, expired))
      .returning({ id: idColumn });

    removed += deleted.length;

    if (deleted.length < BATCH_SIZE) return removed;
  }
};

/**
 * Prunes `logins` (geo-IP rows per sign-in) and `activity_log` (audit
 * rows per action) older than `config.server.retentionDays`. Both tables
 * carry PII and grow with every request; the admin views are paginated
 * but nothing else ever deleted from them.
 *
 * `retentionDays` 0 (or any non-positive value) disables pruning. The
 * cutoff is computed once per run so a long first prune uses one
 * consistent boundary.
 */
const pruneExpiredLogs = async (
  retentionDays: number = config.server.retentionDays
): Promise<{ logins: number; activityLog: number }> => {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    logger.debug(
      `${chalk.dim('[Cron]')} Log retention disabled (retentionDays=${retentionDays}).`
    );
    return { logins: 0, activityLog: 0 };
  }

  const cutoff = Date.now() - retentionDays * DAY_MS;

  const loginsRemoved = await pruneTable(
    logins,
    logins.id,
    logins.createdAt,
    cutoff
  );
  const activityLogRemoved = await pruneTable(
    activityLog,
    activityLog.id,
    activityLog.createdAt,
    cutoff
  );

  const summary = `Log retention (${retentionDays}d): removed ${loginsRemoved} login(s), ${activityLogRemoved} activity-log row(s).`;
  if (loginsRemoved > 0 || activityLogRemoved > 0) {
    logger.info(`${chalk.dim('[Cron]')} ${summary}`);
  } else {
    logger.debug(`${chalk.dim('[Cron]')} ${summary}`);
  }

  return { logins: loginsRemoved, activityLog: activityLogRemoved };
};

export { pruneExpiredLogs };
