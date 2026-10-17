import chalk from 'chalk';
import { inArray, lt } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { config } from '../config';
import { db } from '../db';
import { dmMessages, messages } from '../db/schema';
import { logger } from '../logger';

// Rows deleted per statement — the same batching as log retention: a
// small lock footprint per DELETE and the single Bun thread yielded
// between batches on an instance with a long backlog.
const BATCH_SIZE = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const purgeTable = async (
  table: PgTable,
  idColumn: PgColumn,
  deletedAtColumn: PgColumn,
  cutoff: number
): Promise<number> => {
  let removed = 0;

  for (;;) {
    // `deleted_at < cutoff` is NULL (false) for live rows, so only
    // tombstones match, and the partial index on deleted_at serves it.
    const expired = db
      .select({ id: idColumn })
      .from(table)
      .where(lt(deletedAtColumn, cutoff))
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
 * Hard-deletes message and DM-message tombstones older than
 * `retentionDays` (db/mutations/messages.ts made them; nothing but the
 * row and its reply/thread links is left to remove — a reply's
 * replyToId goes NULL by the FK, which the reply preview already
 * renders as a deleted target). 0 or any non-positive value keeps
 * tombstones forever. `now` is injectable for the tick test; the cutoff
 * is computed once so a long first sweep uses one boundary.
 */
const purgeExpiredTombstones = async (
  now: number = Date.now(),
  retentionDays: number = config.server.tombstoneRetentionDays
): Promise<{ messages: number; dmMessages: number }> => {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    logger.debug(
      `${chalk.dim('[Cron]')} Tombstone retention disabled (tombstoneRetentionDays=${retentionDays}).`
    );
    return { messages: 0, dmMessages: 0 };
  }

  const cutoff = now - retentionDays * DAY_MS;

  const messagesRemoved = await purgeTable(
    messages,
    messages.id,
    messages.deletedAt,
    cutoff
  );
  const dmMessagesRemoved = await purgeTable(
    dmMessages,
    dmMessages.id,
    dmMessages.deletedAt,
    cutoff
  );

  const summary = `Tombstone retention (${retentionDays}d): removed ${messagesRemoved} message(s), ${dmMessagesRemoved} DM message(s).`;
  if (messagesRemoved > 0 || dmMessagesRemoved > 0) {
    logger.info(`${chalk.dim('[Cron]')} ${summary}`);
  } else {
    logger.debug(`${chalk.dim('[Cron]')} ${summary}`);
  }

  return { messages: messagesRemoved, dmMessages: dmMessagesRemoved };
};

export { purgeExpiredTombstones };
