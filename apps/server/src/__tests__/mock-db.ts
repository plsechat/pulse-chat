import { mock } from 'bun:test';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DRIZZLE_PATH } from '../helpers/paths';
import { seedDatabase } from './seed';
import { TRUNCATE_ALL_SQL } from './truncate';

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
// Mirrors db/index.ts: advisory-lock transactions run on their own
// small pool so locked crons can never starve the main one.
const lockClient = postgres(testDatabaseUrl, { max: 4 });
const lockDb: PostgresJsDatabase = drizzle({ client: lockClient });

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
  lockDb,
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
// bootstrap seed is the first thing in the table. The statement is
// derived from the schema (see truncate.ts) so it can't drift.
await tdb.execute(TRUNCATE_ALL_SQL);

await seedDatabase(tdb);

export { client, dbProxy, DRIZZLE_PATH, getTestDb, lockClient, setTestDb };
