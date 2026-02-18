import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test';
import { sql } from 'drizzle-orm';
import fs from 'node:fs/promises';
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

beforeEach(async () => {
  const tdb = getTestDb();

  // Truncate all tables in reverse dependency order
  await tdb.execute(sql`TRUNCATE TABLE
    e2ee_sender_keys,
    user_one_time_pre_keys,
    user_signed_pre_keys,
    user_identity_keys,
    plugin_data,
    channel_read_states,
    channel_user_permissions,
    channel_role_permissions,
    message_reactions,
    message_files,
    activity_log,
    logins,
    user_roles,
    messages,
    emojis,
    invites,
    files,
    users,
    role_permissions,
    roles,
    channels,
    categories,
    servers,
    settings
    RESTART IDENTITY CASCADE`);

  await seedDatabase(tdb);
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
