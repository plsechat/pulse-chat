import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
import { warmFileHmacSecret } from '../db/queries/server';
import { DATA_PATH } from '../helpers/paths';
import { createHttpServer } from '../http';
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

// Retry helper for deadlocks during beforeEach. The HTTP test server
// and the `tdb` client share a postgres-js pool (mock-db.ts forwards
// `db` -> `tdb`), so a TRUNCATE in beforeEach can collide with a still-
// in-flight HTTP-handler query from the previous test. Postgres rolls
// back one side; retrying almost always succeeds on the second try.
//
// As the suite has grown, the contention window has too — three retries
// with linear backoff ran out for runs that happened to land mid-query.
// Bumped to six attempts with exponential backoff (100, 200, 400, 800,
// 1600 ms) so the cumulative wait covers any reasonable in-flight
// HTTP-handler tail.
const POSTGRES_DEADLOCK_CODE = '40P01';

async function executeWithDeadlockRetry(
  fn: () => Promise<void>,
  retries = 6
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fn();
      return;
    } catch (err: unknown) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== POSTGRES_DEADLOCK_CODE || attempt >= retries) throw err;
      // Exponential backoff: 100, 200, 400, 800, 1600 ms — gives the
      // colliding transaction enough time to finish before we retry.
      await new Promise((r) => setTimeout(r, 100 * 2 ** (attempt - 1)));
    }
  }
}

beforeEach(async () => {
  const tdb = getTestDb();

  // Truncate all tables in reverse dependency order. Keep this list in
  // sync with the schema — leftover rows in tables that aren't truncated
  // here lengthen CASCADE chains and widen deadlock windows.
  await executeWithDeadlockRetry(() => tdb.execute(sql`TRUNCATE TABLE
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
    RESTART IDENTITY CASCADE`).then(() => undefined));

  await seedDatabase(tdb);

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

  await client.end();
});

export { dbProxy as tdb, getTestDb, testsBaseUrl };
