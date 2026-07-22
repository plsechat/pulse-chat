import chalk from 'chalk';
import { removeFile } from '../db/mutations/files';
import { getOrphanedFileIds } from '../db/queries/files';
import { logger } from '../logger';

const cleanupFiles = async (): Promise<number> => {
  logger.debug(`${chalk.dim('[Cron]')} Starting file cleanup...`);

  const orphanedFileIds = await getOrphanedFileIds();

  if (orphanedFileIds.length === 0) {
    logger.debug(`${chalk.dim('[Cron]')} No orphaned files found.`);
    return 0;
  }

  logger.info(
    `${chalk.dim('[Cron]')} Found ${orphanedFileIds.length} orphaned files. Cleaning up...`
  );

  const promises = orphanedFileIds.map(async (fileId) => {
    await removeFile(fileId);
  });

  await Promise.all(promises);

  logger.info(
    `${chalk.dim('[Cron]')} Cleaned up ${orphanedFileIds.length} orphaned files.`
  );
  return orphanedFileIds.length;
};

export { cleanupFiles };
