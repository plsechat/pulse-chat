import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import { warmFileHmacSecret } from '../db/queries/server';
import { DATA_PATH } from '../helpers/paths';
import { createHttpServer } from '../http';
import { activityLogQueue } from '../queues/activity-log';
import { drainQueue } from '../queues/drain';
import { loginsQueue } from '../queues/logins';
import { loadMediasoup } from '../utils/mediasoup';
import { client, dbProxy, getTestDb } from './mock-db';
import { seedDatabase } from './seed';

/**
 * Global test setup - truncates all tables and re-seeds before each test.
 * This ensures tests don't interfere with each other.
 *
 * NOTE: Console suppression and module mocks (config, logger, supabase)
 * are handled in mock-modules.ts which runs before this file.
 */

const CLEANUP_AFTER_FINISH = true;

let testsBaseUrl: string;

beforeAll(async () => {
  await createHttpServer(9999);
  await loadMediasoup();

  testsBaseUrl = 'http://localhost:9999';
});

// ── Between-test reset hardening ─────────────────────────────────────
//
// The HTTP test server and the `tdb` client share a postgres-js pool
// (mock-db.ts forwards `db` -> `tdb`), and routes fire-and-forget
// background work (activity-log / logins queue inserts, publisher
// SELECT fan-outs) that regularly OUTLIVES the test that started it.
// That straggler work racing the next test's TRUNCATE is the single
// mechanism behind all three recurring CI flake signatures:
//
//   1. `deadlock detected` — a straggler query's lock order inverts
//      against the multi-table TRUNCATE.
//   2. a 5000ms test timeout followed by `duplicate key ... roles_pkey`
//      — bun cannot cancel an awaited hook promise, so a TRUNCATE+seed
//      chain that blew the test-timeout budget keeps running DETACHED
//      and interleaves with the next test's reseed.
//   3. `CONNECTION_ENDED` — stragglers racing `client.end()` in
//      afterAll.
//
// Defenses, layered:
//   - beforeEach DRAINS the fire-and-forget queues before touching the
//     DB (kills the largest straggler source at the source);
//   - TRUNCATE + seed run in ONE transaction, so a detached chain and
//     the current reset serialize atomically instead of interleaving —
//     the duplicate-key corruption is impossible by construction;
//   - `SET LOCAL lock_timeout` fails fast instead of silently eating
//     the hook-timeout budget when a straggler holds a lock;
//   - the retry loop covers every failure mode the race can produce
//     (deadlock, lock timeout, unique violation, ended connection),
//     with exponential backoff (100..3200 ms over 6 attempts).
const RETRYABLE_PG_CODES = new Set([
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (our SET LOCAL lock_timeout tripping)
  '23505' // unique_violation (a detached seed interleaved with ours)
]);

// Drizzle wraps the underlying postgres-js error in a DrizzleQueryError
// whose `.code` is undefined — the postgres `code` lives on `.cause`.
// Walk the cause chain so we catch codes regardless of wrapping depth.
function isRetryableResetError(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth++) {
    const code = (cur as { code?: string }).code;
    if (code && RETRYABLE_PG_CODES.has(code)) return true;
    const message = (cur as { message?: string }).message;
    if (message?.includes('CONNECTION_ENDED')) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

async function executeWithResetRetry(
  fn: () => Promise<void>,
  retries = 6
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err: unknown) {
      if (!isRetryableResetError(err) || attempt >= retries) throw err;
      // 100, 200, 400, 800, 1600 ms — gives the colliding transaction
      // enough time to finish before we retry.
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
  }
}

beforeEach(async () => {
  const tdb = getTestDb();

  // Quiesce fire-and-forget DB writers from the previous test BEFORE
  // taking the truncate locks. Cheap when idle (sync no-op).
  await Promise.all([
    drainQueue(activityLogQueue),
    drainQueue(loginsQueue)
  ]);

  // Truncate all tables in reverse dependency order, then reseed —
  // atomically, inside one transaction (see hardening note above).
  // Keep the table list in sync with the schema — leftover rows in
  // tables that aren't truncated here lengthen CASCADE chains and
  // widen deadlock windows.
  await executeWithResetRetry(() =>
    tdb.transaction(async (tx) => {
      // Fail fast instead of eating the whole hook-timeout budget when
      // a straggler still holds a lock; 55P03 is retried with backoff.
      await tx.execute(sql`SET LOCAL lock_timeout = '2500ms'`);
      await tx.execute(sql`TRUNCATE TABLE
    e2ee_sender_keys,
    user_key_backups,
    user_one_time_pre_keys,
    user_signed_pre_keys,
    user_identity_keys,
    user_preferences,
    user_notes,
    plugin_data,
    thread_followers,
    forum_post_tags,
    forum_tags,
    channel_notification_settings,
    channel_read_states,
    channel_user_permissions,
    channel_role_permissions,
    message_reactions,
    message_files,
    dm_read_states,
    dm_message_reactions,
    dm_message_files,
    dm_messages,
    dm_channel_members,
    dm_channels,
    friend_requests,
    friendships,
    activity_log,
    logins,
    server_members,
    user_roles,
    webhooks,
    automod_rules,
    messages,
    emojis,
    invites,
    files,
    user_federated_servers,
    federation_instances,
    federation_keys,
    users,
    role_permissions,
    roles,
    channels,
    categories,
    servers,
    settings
    RESTART IDENTITY CASCADE`);

      // seedDatabase's param is typed as the plain database handle; a
      // drizzle transaction exposes the identical query API (insert/
      // update/select/execute), so the cast is safe here.
      await seedDatabase(tx as unknown as Parameters<typeof seedDatabase>[0]);
    })
  );

  // Warm the file-HMAC cache. Production never calls this explicitly either;
  // tests that exercised generateFileToken used to depend on cross-file mock
  // leakage from files-crypto.test.ts. With more test files in the suite
  // that order is no longer deterministic, so we warm it here. Cache is
  // module-scoped and persists across tests, so this is a one-time cost
  // on first call.
  await warmFileHmacSecret();
});

afterEach(() => {
  // No cleanup needed - tables are truncated in beforeEach
});

afterAll(async () => {
  if (CLEANUP_AFTER_FINISH) {
    try {
      await fs.rm(DATA_PATH, { recursive: true });
    } catch {
      // ignore
    }
  }

  // Drain stragglers before ending the pool — a queued insert racing
  // client.end() is the CONNECTION_ENDED flake.
  await Promise.all([
    drainQueue(activityLogQueue),
    drainQueue(loginsQueue)
  ]);

  await client.end();
});

export { dbProxy as tdb, getTestDb, testsBaseUrl };
