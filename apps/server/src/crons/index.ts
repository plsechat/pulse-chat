import { CronJob } from 'cron';
import { logger } from '../logger';
import { cleanupEmptyThreads } from './cleanup-empty-threads';
import { cleanupFiles } from './cleanup-files';

enum CRON_TIMES {
  EVERY_5_MINUTES = '*/5 * * * *',
  EVERY_15_MINUTES = '*/15 * * * *'
}

const loadCrons = () => {
  logger.debug('Loading crons...');

  new CronJob(
    CRON_TIMES.EVERY_15_MINUTES,
    cleanupFiles,
    null,
    true,
    'Europe/Lisbon',
    null,
    true
  );

  // Empty-thread sweep runs more often than file cleanup because the
  // window in which a stray thread is visible to other members
  // matters — if user A right-clicks Create Thread by accident in a
  // busy channel, user B sees a "Thread" entry in the threads list
  // until the sweep fires. 5 minutes balances "responsive cleanup"
  // against "DB load." MIN_AGE_MS in cleanup-empty-threads.ts gates
  // *which* threads get deleted, so a sub-5min user grace period
  // still works regardless of cron frequency.
  new CronJob(
    CRON_TIMES.EVERY_5_MINUTES,
    cleanupEmptyThreads,
    null,
    true,
    'Europe/Lisbon',
    null,
    true
  );
};

export { loadCrons };
