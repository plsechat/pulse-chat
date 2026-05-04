import { mock } from 'bun:test';
import { sql } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DRIZZLE_PATH } from '../helpers/paths';
import { seedDatabase } from './seed';

/**
 * This file is preloaded via bunfig.toml to mock the db module
 * before any other code imports it.
 *
 * Architecture:
 * 1. mock-modules.ts - Mocks config/logger/supabase (runs before this)
 * 2. prepare.ts      - Creates directories, copies migrations
 * 3. mock-db.ts (this file) - Mocks db, connects to test DB, runs migrations
 * 4. setup.ts        - beforeEach truncates tables and re-seeds for each test
 *
 * CRITICAL: All exports and mock.module calls are declared ABOVE the
 * database initialization await. This prevents TDZ errors if the DB
 * connection fails — exports remain accessible for error reporting.
 */

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!testDatabaseUrl) {
  throw new Error(
    'TEST_DATABASE_URL or DATABASE_URL must be set for running tests'
  );
}

const client = postgres(testDatabaseUrl);
let tdb: PostgresJsDatabase = drizzle({ client });

const setTestDb = (newDb: PostgresJsDatabase) => {
  tdb = newDb;
};

const getTestDb = () => tdb;

// Create a Proxy that forwards all operations to the current tdb
// so that setTestDb() properly updates the active database.
const dbProxy = new Proxy({} as PostgresJsDatabase, {
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (tdb as any)[prop];
  },
  set(_target, prop, value) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tdb as any)[prop] = value;
    return true;
  }
});

// Mock the db module BEFORE any other code imports it
mock.module('../db/index', () => ({
  db: dbProxy,
  loadDb: async () => {} // No-op in tests
}));

// ── Database initialization (with retry for CI service containers) ──

const waitForDb = async (maxRetries = 15, intervalMs = 2000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await client`SELECT 1`;
      return;
    } catch (err) {
      if (i === maxRetries - 1) {
        console.error('Failed to connect to test database after %d attempts', maxRetries);
        throw err;
      }
      console.error(
        'Waiting for database... (attempt %d/%d)',
        i + 1,
        maxRetries
      );
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
};

await waitForDb();
await migrate(tdb, { migrationsFolder: DRIZZLE_PATH });

// Truncate before the bootstrap seed. In CI we now run one bun-test
// invocation per file within a shard, all sharing the same postgres
// service container. The PREVIOUS process's last beforeEach left
// fully-seeded data in the DB at process exit — when the NEXT process
// reaches this point and calls seedDatabase, the explicit-id INSERTs
// (role id=1, server id=1, etc) collide with that leftover data.
// setup.ts's beforeEach already truncates, but it only runs before
// each test, not at module load. Reset everything here so the
// bootstrap seed is the first thing in the table.
await tdb.execute(sql`TRUNCATE TABLE
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

await seedDatabase(tdb);

export { client, dbProxy, DRIZZLE_PATH, getTestDb, setTestDb };
