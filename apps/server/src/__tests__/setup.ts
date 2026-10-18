import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import dns from 'dns/promises';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import { warmFileHmacSecret } from '../db/queries/server';
import { DATA_PATH } from '../helpers/paths';
import { createHttpServer } from '../http';
import { activityLogQueue } from '../queues/activity-log';
import { dmMessageMetadataQueue } from '../queues/dm-message-metadata';
import { drainQueue } from '../queues/drain';
import { loginsQueue } from '../queues/logins';
import { messageMetadataQueue } from '../queues/message-metadata';
import { VoiceRuntime } from '../runtimes/voice';
import { loadBannedUsersCache } from '../utils/banned-cache';
import { loadMediasoup } from '../utils/mediasoup';
import { client, dbProxy, getTestDb, lockClient } from './mock-db';
import { seedDatabase } from './seed';
import { TRUNCATE_ALL_SQL } from './truncate';

/**
 * Global test setup - truncates all tables and re-seeds before each test.
 * This ensures tests don't interfere with each other.
 *
 * NOTE: Console suppression and module mocks (config, logger, supabase)
 * are handled in mock-modules.ts which runs before this file.
 */

const CLEANUP_AFTER_FINISH = true;

let testsBaseUrl: string;

// ── Mock-leak guard ──────────────────────────────────────────────────
//
// Test files stub `globalThis.fetch` and `dns.resolve4/6` (via spyOn)
// to keep federation traffic off the network. Those stubs are
// restorable — and MUST be restored, or every later file in the same
// process sees the stub: validate-url.test.ts' SSRF rejections "pass"
// a URL the fake accepts, dispatcher tests never see their traffic.
// afterAll compares the live values against the originals captured at
// preload time and fails the run loudly if a file leaked.
//
// `mock.module` is worse: it is process-global and cannot be undone.
// The server eslint config forbids it outside the four preload files.
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_DNS_RESOLVE4 = dns.resolve4;
const ORIGINAL_DNS_RESOLVE6 = dns.resolve6;

const isMockFn = (fn: unknown): boolean =>
  typeof fn === 'function' && 'mock' in fn;

const findLeakedMocks = (): string[] => {
  const leaks: string[] = [];
  if (globalThis.fetch !== ORIGINAL_FETCH || isMockFn(globalThis.fetch)) {
    leaks.push('globalThis.fetch');
  }
  if (dns.resolve4 !== ORIGINAL_DNS_RESOLVE4 || isMockFn(dns.resolve4)) {
    leaks.push('dns.resolve4');
  }
  if (dns.resolve6 !== ORIGINAL_DNS_RESOLVE6 || isMockFn(dns.resolve6)) {
    leaks.push('dns.resolve6');
  }
  return leaks;
};

const drainFireAndForgetQueues = () =>
  Promise.all([
    drainQueue(activityLogQueue),
    drainQueue(loginsQueue),
    drainQueue(messageMetadataQueue),
    drainQueue(dmMessageMetadataQueue)
  ]);

// TEST_HTTP_PORT lets several suites run side by side on one machine
// (each against its own DATABASE_URL); CI and the default local run use 9999.
const TEST_HTTP_PORT = Number(process.env.TEST_HTTP_PORT ?? 9999);

beforeAll(async () => {
  await createHttpServer(TEST_HTTP_PORT);
  await loadMediasoup();

  testsBaseUrl = `http://localhost:${TEST_HTTP_PORT}`;
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
  // taking the truncate locks. Cheap when idle (sync no-op). The two
  // message-metadata queues issue an UPDATE per non-E2EE send — a
  // straggler there races the TRUNCATE exactly like the log queues.
  await drainFireAndForgetQueues();

  // Truncate every schema table (truncate.ts derives the list from
  // db/schema.ts, so a new table can't be forgotten), then reseed —
  // atomically, inside one transaction (see hardening note above).
  await executeWithResetRetry(() =>
    tdb.transaction(async (tx) => {
      // Fail fast instead of eating the whole hook-timeout budget when
      // a straggler still holds a lock; 55P03 is retried with backoff.
      await tx.execute(sql`SET LOCAL lock_timeout = '2500ms'`);
      await tx.execute(TRUNCATE_ALL_SQL);

      // seedDatabase's param is typed as the plain database handle; a
      // drizzle transaction exposes the identical query API (insert/
      // update/select/execute), so the cast is safe here.
      await seedDatabase(tx as unknown as Parameters<typeof seedDatabase>[0]);
    })
  );

  // Voice rooms are process memory too: a room one test file left open
  // keeps its channel id, and the next file's reseed hands that id to a
  // different channel — a "no room exists" assertion then fails on a
  // stranger's room. Close every runtime before the fresh rows land.
  await VoiceRuntime.destroyAll();

  // The banned-user cache is process memory: a ban in one test file would
  // otherwise follow the (re-seeded) user id into every later file in the
  // same process. Re-scan after each reseed so it mirrors the fresh rows.
  await loadBannedUsersCache();

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
  // Check for leaked mocks first, but only throw after the pool is
  // closed — a thrown guard must not leave postgres connections open.
  const leakedMocks = findLeakedMocks();

  if (CLEANUP_AFTER_FINISH) {
    try {
      await fs.rm(DATA_PATH, { recursive: true });
    } catch {
      // ignore
    }
  }

  // Drain stragglers before ending the pool — a queued insert racing
  // client.end() is the CONNECTION_ENDED flake.
  await drainFireAndForgetQueues();

  await Promise.all([client.end(), lockClient.end()]);

  if (leakedMocks.length > 0) {
    throw new Error(
      `A test file leaked a mock past its last test: ${leakedMocks.join(', ')}. ` +
        'Restore it in afterEach (mock.restore() for spyOn stubs). ' +
        'Later files in the same process would otherwise run against the stub.'
    );
  }
});

export { getTestDb, dbProxy as tdb, testsBaseUrl };
