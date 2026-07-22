import { CronJob } from 'cron';
import { escalateStaleReports } from '../db/queries/reports';
import { logger } from '../logger';
import { cleanupEmptyThreads } from './cleanup-empty-threads';
import { cleanupFiles } from './cleanup-files';
import { cleanupOrphanVoiceUsers } from './cleanup-orphan-voice';

enum CRON_TIMES {
  EVERY_MINUTE = '* * * * *',
  EVERY_5_MINUTES = '*/5 * * * *',
  EVERY_15_MINUTES = '*/15 * * * *',
  EVERY_HOUR = '0 * * * *'
}

const loadCrons = () => {
  logger.debug('Loading crons...');

  // cleanupFiles returns the removed count for the admin manual
  // trigger; the cron discards it (CronJob wants a void callback).
  new CronJob(
    CRON_TIMES.EVERY_15_MINUTES,
    () => {
      cleanupFiles().catch((err) =>
        logger.error('[crons] file cleanup failed: %o', err)
      );
    },
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

  // Orphan-voice sweep runs every minute: it reconciles the in-memory
  // voice runtimes against live WS connections, so a leaked entry (any
  // teardown path the close handler misses) strands a ghost peer for at
  // most ~60s instead of until server restart. Cheap — purely in-memory
  // iteration unless an orphan is actually found.
  new CronJob(
    CRON_TIMES.EVERY_MINUTE,
    cleanupOrphanVoiceUsers,
    null,
    true,
    'Europe/Lisbon',
    null,
    true
  );

  // Stale-report escalation: a server-queue report the mods have
  // ignored for 7 days moves to the instance operator (audience flip,
  // reason 'stale'). Hourly is plenty — the trigger window is days —
  // and the sweep is one bounded UPDATE on an indexed predicate.
  new CronJob(
    CRON_TIMES.EVERY_HOUR,
    () => {
      escalateStaleReports().catch((err) =>
        logger.error('[crons] stale-report escalation failed: %o', err)
      );
    },
    null,
    true,
    'Europe/Lisbon',
    null,
    true
  );
};

export { loadCrons };
