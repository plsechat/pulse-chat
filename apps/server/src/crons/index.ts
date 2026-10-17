import { CronJob } from 'cron';
import { escalateStaleReports } from '../db/queries/reports';
import { logger } from '../logger';
import { CRON_LOCK_IDS, tryWithAdvisoryLock } from './advisory-lock';
import { cleanupExpiredAuthSessions } from './cleanup-auth-sessions';
import { cleanupEmptyThreads } from './cleanup-empty-threads';
import { cleanupFiles } from './cleanup-files';
import { cleanupOrphanVoiceUsers } from './cleanup-orphan-voice';
import { directoryTick } from './directory';
import { eventsTick } from './events';
import { drainOutboxTick } from './federation-outbox';
import { pruneFederationReplayState } from './federation-seen-jti';
import { expireGamePresenceTick } from './game-presence';
import { closeExpiredPollsTick } from './polls';
import { pruneExpiredLogs } from './retention';
import { scheduledPostsTick } from './scheduled-posts';
import { purgeExpiredTombstones } from './tombstones';
import { bridgeSyncTick } from '../routers/servers/bridge-sync';

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

  // Message tombstones ("Message deleted" rows) age out after
  // config.server.tombstoneRetentionDays, in 1000-row batches on the
  // partial deleted_at indexes. Daily plus boot, like log retention;
  // no fan-out — a viewer who still has the row sees the placeholder
  // until their next load, which is the same thing they saw before.
  scheduleCron(
    'tombstone-retention',
    CRON_TIMES.EVERY_DAY,
    () => purgeExpiredTombstones(),
    CRON_LOCK_IDS.TOMBSTONE_RETENTION
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

  // Whole-server bridge: one cheap SELECT a minute while no server is
  // linked; with links, one in-process call asks the bridge plugin
  // whether the remote side changed (a channel created or deleted over
  // there, a gateway reconnect) and re-pairs the servers that need it.
  // The plugin cannot call a server route through the SDK, so this tick
  // is its way back to us. In-process state, deliberately unlocked.
  scheduleCron('bridge-sync', CRON_TIMES.EVERY_MINUTE, () => bridgeSyncTick());

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

  // Public directory: peers' listings are pulled in full daily (and at
  // boot, so a restarted instance shows its peers' servers at once);
  // the counts on the cached rows are refreshed hourly. Both are one
  // signed, capped call per active peer, visited in sequence, so the
  // lock only matters when a peer sits at the request timeout. No-op
  // while federation is off.
  scheduleCron(
    'directory-pull',
    CRON_TIMES.EVERY_DAY,
    () => directoryTick('full'),
    CRON_LOCK_IDS.DIRECTORY_PULL
  );

  scheduleCron(
    'directory-counts',
    CRON_TIMES.EVERY_HOUR,
    () => directoryTick('counts'),
    CRON_LOCK_IDS.DIRECTORY_COUNTS
  );

  // Event timeline: reminders, the T-15 room, 'live', the end+15
  // teardown. Minute resolution is the contract the owner decided on
  // (15 min before / after); the lock keeps a slow tick (room creation
  // waits on mediasoup) from overlapping the next one.
  scheduleCron(
    'events',
    CRON_TIMES.EVERY_MINUTE,
    () => eventsTick(),
    CRON_LOCK_IDS.EVENTS
  );

  // Scheduled posts go out at minute resolution (the picker's unit); a
  // tick with nothing due is one indexed SELECT. The lock keeps a slow
  // tick (automod over a backlog) from overlapping the next.
  scheduleCron(
    'scheduled-posts',
    CRON_TIMES.EVERY_MINUTE,
    () => scheduledPostsTick(),
    CRON_LOCK_IDS.SCHEDULED_POSTS
  );

  // Poll deadlines are minutes too; the conditional close makes a tick
  // that overlaps a manual close harmless, the lock makes it rare.
  scheduleCron(
    'polls-close',
    CRON_TIMES.EVERY_MINUTE,
    () => closeExpiredPollsTick(),
    CRON_LOCK_IDS.POLLS_CLOSE
  );

  // Game presence older than 6 h is a ghost (a shell that crashed, or a
  // server restart that lost the last-socket clear). Five minutes keeps
  // the overshoot short; the tick is one UPDATE over the few rows that
  // carry a presence at all, plus a fan-out per cleared user.
  scheduleCron(
    'game-presence-expiry',
    CRON_TIMES.EVERY_5_MINUTES,
    () => expireGamePresenceTick(),
    CRON_LOCK_IDS.GAME_PRESENCE_EXPIRY
  );
};

export { loadCrons, scheduleCron };
