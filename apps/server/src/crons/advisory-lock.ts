import { sql } from 'drizzle-orm';
import { lockDb } from '../db';

/**
 * Instance-wide mutual exclusion for periodic jobs. Every replica runs
 * every cron, so without a lock two replicas (or a cron tick and the
 * admin's manual trigger) run the same sweep at once: double deletes,
 * double publishes, twice the load.
 *
 * The lock is a TRANSACTION-scoped Postgres advisory lock
 * (`pg_try_advisory_xact_lock`): it is taken on the one connection the
 * transaction pins and released automatically when the transaction
 * ends, which sidesteps the pooled-connection trap of the session-level
 * variant (lock on connection A, unlock attempted on connection B, lock
 * held until A closes). The job's own statements run on the main pool
 * — the open transaction only carries the lock, it holds no table
 * locks — and the transaction itself lives on `lockDb`, a pool of its
 * own: on the main pool, every locked cron firing at boot pinned a
 * connection while its statements queued for one more, and the twelfth
 * locked cron turned that into a deadlock that stalled the server.
 *
 * Lock ids are arbitrary 32-bit keys; keep them distinct from the
 * migration lock in db/index.ts (827394827).
 */
const CRON_LOCK_IDS = {
  CLEANUP_FILES: 827394901,
  CLEANUP_EMPTY_THREADS: 827394902,
  ESCALATE_STALE_REPORTS: 827394903,
  LOG_RETENTION: 827394904,
  CLEANUP_AUTH_SESSIONS: 827394905,
  FEDERATION_OUTBOX: 827394906,
  FEDERATION_SEEN_JTI: 827394910,
  EVENTS: 827394911,
  DIRECTORY_PULL: 827394912,
  DIRECTORY_COUNTS: 827394913,
  POLLS_CLOSE: 827394914,
  SCHEDULED_POSTS: 827394915
} as const;

type TLockOutcome<T> = { acquired: false } | { acquired: true; result: T };

/**
 * Run `fn` while holding `lockId`; report `acquired: false` without
 * running it when another holder has it (the caller skips this tick).
 */
const tryWithAdvisoryLock = async <T>(
  lockId: number,
  fn: () => Promise<T>
): Promise<TLockOutcome<T>> =>
  lockDb.transaction(async (tx) => {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(${lockId}) AS locked`
    );

    if (rows[0]?.locked !== true) {
      return { acquired: false };
    }

    return { acquired: true, result: await fn() };
  });

export { CRON_LOCK_IDS, tryWithAdvisoryLock };
