import { CronJob } from 'cron';
import { escalateStaleReports } from '../db/queries/reports';
import { logger } from '../logger';
import { CRON_LOCK_IDS, tryWithAdvisoryLock } from './advisory-lock';
import { cleanupExpiredAuthSessions } from './cleanup-auth-sessions';
import { cleanupEmptyThreads } from './cleanup-empty-threads';
import { cleanupFiles } from './cleanup-files';
import { cleanupOrphanVoiceUsers } from './cleanup-orphan-voice';
import { drainOutboxTick } from './federation-outbox';
import { pruneFederationReplayState } from './federation-seen-jti';
import { pruneExpiredLogs } from './retention';

enum CRON_TIMES {
  EVERY_30_SECONDS = '*/30 * * * * *',
  EVERY_MINUTE = '* * * * *',
  EVERY_5_MINUTES = '*/5 * * * *',
  EVERY_15_MINUTES = '*/15 * * * *',
  EVERY_HOUR = '0 * * * *',
  EVERY_DAY = '0 4 * * *'
}

/**
 * Every job goes through here so no cron can fail silently: the cron
 * library's default for a rejected tick is `console.error`, which
 * bypasses the logger (no file, no admin ring, no redaction). The
 * wrapper catches the rejection itself and ALSO hands the library an
 * `errorHandler` for anything thrown outside the promise.
 *
 * `lockId` serializes a job across processes (see advisory-lock.ts): a
 * tick that finds the lock held skips. PULSE runs as ONE process per
 * database (README "Deployment model"); the lock is defence in depth so
 * an accidental second process cannot double-run a sweep. Jobs that
 * reconcile this process's own memory (orphan-voice) pass no lock.
 */
const scheduleCron = (
  name: string,
  cronTime: string,
  job: () => Promise<unknown>,
  lockId?: number
) => {
  const onError = (err: unknown) =>
    logger.error('[crons] %s failed: %o', name, err);

  const onTick = async () => {
    try {
      if (lockId === undefined) {
        await job();
        return;
      }

      const outcome = await tryWithAdvisoryLock(lockId, job);
      if (!outcome.acquired) {
        logger.debug('[crons] %s skipped: another run holds the lock', name);
      }
    } catch (err) {
      onError(err);
    }
  };

  return CronJob.from({
    cronTime,
    onTick,
    start: true,
    runOnInit: true,
    errorHandler: onError,
    name
  });
};

const loadCrons = () => {
  logger.debug('Loading crons...');

  // cleanupFiles returns the removed count for the admin manual
  // trigger and takes its own lock (the manual trigger must exclude a
  // concurrent tick too), so it is scheduled without one here.
  scheduleCron('cleanup-files', CRON_TIMES.EVERY_15_MINUTES, cleanupFiles);

  // Empty-thread sweep runs more often than file cleanup because the
  // window in which a stray thread is visible to other members
  // matters — if user A right-clicks Create Thread by accident in a
  // busy channel, user B sees a "Thread" entry in the threads list
  // until the sweep fires. 5 minutes balances "responsive cleanup"
  // against "DB load." MIN_AGE_MS in cleanup-empty-threads.ts gates
  // *which* threads get deleted, so a sub-5min user grace period
  // still works regardless of cron frequency.
  scheduleCron(
    'cleanup-empty-threads',
    CRON_TIMES.EVERY_5_MINUTES,
    cleanupEmptyThreads,
    CRON_LOCK_IDS.CLEANUP_EMPTY_THREADS
  );

  // Orphan-voice sweep runs every minute: it reconciles the in-memory
  // voice runtimes against live WS connections, so a leaked entry (any
  // teardown path the close handler misses) strands a ghost peer for at
  // most ~60s instead of until server restart. Cheap — purely in-memory
  // iteration unless an orphan is actually found. Per-replica state, so
  // deliberately unlocked.
  scheduleCron(
    'cleanup-orphan-voice',
    CRON_TIMES.EVERY_MINUTE,
    cleanupOrphanVoiceUsers
  );

  // Stale-report escalation: a server-queue report the mods have
  // ignored for 7 days moves to the instance operator (audience flip,
  // reason 'stale'). Hourly is plenty — the trigger window is days —
  // and the sweep is one bounded UPDATE on an indexed predicate.
  scheduleCron(
    'escalate-stale-reports',
    CRON_TIMES.EVERY_HOUR,
    escalateStaleReports,
    CRON_LOCK_IDS.ESCALATE_STALE_REPORTS
  );

  // Log retention: logins and activity_log rows older than
  // config.server.retentionDays go, in 1000-row batches. Daily at 04:00
  // (server local time) plus once at boot so an instance that restarts
  // more often than that still prunes. Bounded per batch, so the boot
  // run is cheap on an instance with nothing to delete.
  scheduleCron(
    'log-retention',
    CRON_TIMES.EVERY_DAY,
    pruneExpiredLogs,
    CRON_LOCK_IDS.LOG_RETENTION
  );

  // Local-auth session rows outlive their refresh token's 30 days only
  // until this sweep; revoked-but-unexpired rows stay because reuse
  // detection needs them. Daily plus boot, same reasoning as retention.
  scheduleCron(
    'cleanup-auth-sessions',
    CRON_TIMES.EVERY_DAY,
    cleanupExpiredAuthSessions,
    CRON_LOCK_IDS.CLEANUP_AUTH_SESSIONS
  );

  // Federation outbox: queued relays to peers that were down or
  // rate-limited. 30 s matches the first backoff step, so a relay that
  // failed inline is retried as soon as it becomes due; the lock keeps
  // a slow tick (peer at the request timeout) from overlapping the
  // next one. No-op per tick when federation is off or nothing is due.
  scheduleCron(
    'federation-outbox',
    CRON_TIMES.EVERY_30_SECONDS,
    drainOutboxTick,
    CRON_LOCK_IDS.FEDERATION_OUTBOX
  );

  // Federation replay cache + retired signing keys: a jti row protects
  // nothing once its signature can no longer verify (6 min), so 15 min
  // keeps the table at roughly one busy quarter-hour of relays; retired
  // keys leave after their 24 h grace. Both DELETEs hit indexed
  // predicates, so a tick with nothing to do is cheap.
  scheduleCron(
    'federation-seen-jti',
    CRON_TIMES.EVERY_15_MINUTES,
    pruneFederationReplayState,
    CRON_LOCK_IDS.FEDERATION_SEEN_JTI
  );
};

export { loadCrons, scheduleCron };
