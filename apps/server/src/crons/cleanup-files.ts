import chalk from 'chalk';
import { and, inArray, lte } from 'drizzle-orm';
import { db } from '../db';
import { removeFile } from '../db/mutations/files';
import { getOrphanedFileIds } from '../db/queries/files';
import { files } from '../db/schema';
import { logger } from '../logger';
import { CRON_LOCK_IDS, tryWithAdvisoryLock } from './advisory-lock';

/**
 * Orphans are removed in slices of this size, each slice awaited before
 * the next starts: a bulk purge used to fire every DELETE + unlink at
 * once (thousands of concurrent statements on the pool, one open file
 * descriptor each).
 */
const DELETE_BATCH_SIZE = 25;

/**
 * A `files` row is written BEFORE the row that references it (the
 * message_files / avatar / emoji insert follows the saveFile call), so
 * a tick landing in that gap would see a fresh upload as an orphan and
 * delete it from under the request. Rows younger than this are left
 * alone; anything older with no reference is gone for real.
 */
const ORPHAN_GRACE_MS = 5 * 60 * 1000;

const removeInBatches = async (fileIds: number[]) => {
  for (let i = 0; i < fileIds.length; i += DELETE_BATCH_SIZE) {
    const slice = fileIds.slice(i, i + DELETE_BATCH_SIZE);
    await Promise.all(slice.map((fileId) => removeFile(fileId)));
  }
};

const sweep = async (): Promise<number> => {
  const orphanedFileIds = await getOrphanedFileIds();

  if (orphanedFileIds.length === 0) {
    logger.debug(`${chalk.dim('[Cron]')} No orphaned files found.`);
    return 0;
  }

  const cutoff = Date.now() - ORPHAN_GRACE_MS;
  const eligible = await db
    .select({ id: files.id })
    .from(files)
    .where(and(inArray(files.id, orphanedFileIds), lte(files.createdAt, cutoff)));
  const fileIds = eligible.map((row) => row.id);

  if (fileIds.length === 0) {
    logger.debug(
      `${chalk.dim('[Cron]')} ${orphanedFileIds.length} orphaned files are inside the grace window; nothing to clean.`
    );
    return 0;
  }

  logger.info(
    `${chalk.dim('[Cron]')} Found ${fileIds.length} orphaned files. Cleaning up...`
  );

  await removeInBatches(fileIds);

  logger.info(`${chalk.dim('[Cron]')} Cleaned up ${fileIds.length} orphaned files.`);
  return fileIds.length;
};

/**
 * Delete every file no table references any more. Returns the number
 * removed (the admin storage panel's manual trigger shows it). Exactly
 * one sweep runs instance-wide at a time: a tick or manual trigger that
 * finds the lock held returns 0 and lets the holder finish.
 */
const cleanupFiles = async (): Promise<number> => {
  logger.debug(`${chalk.dim('[Cron]')} Starting file cleanup...`);

  const outcome = await tryWithAdvisoryLock(CRON_LOCK_IDS.CLEANUP_FILES, sweep);

  if (!outcome.acquired) {
    logger.debug(
      `${chalk.dim('[Cron]')} File cleanup is already running elsewhere; skipping this run.`
    );
    return 0;
  }

  return outcome.result;
};

export { cleanupFiles, DELETE_BATCH_SIZE, ORPHAN_GRACE_MS };
