import { mock } from 'bun:test';
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
await seedDatabase(tdb);

export { client, dbProxy, DRIZZLE_PATH, getTestDb, setTestDb };
