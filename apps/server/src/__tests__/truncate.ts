import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

/**
 * The between-test reset statement, derived from the schema instead of
 * a hand-maintained table list.
 *
 * Two copies of that list used to live in setup.ts and mock-db.ts; they
 * drifted from each other and from the schema (`local_auth_users`,
 * `nameplates`, `user_blocks` were missing — `local_auth_users` has no
 * FK, so CASCADE never reached it and rows leaked across runs against a
 * reused database). Building the statement from every `pgTable` exported
 * by db/schema.ts makes a new table truncated the moment it is added.
 * Order is irrelevant: CASCADE handles FK dependencies.
 *
 * setup.test.ts asserts this list matches the tables that actually exist
 * in the test database, so a table reachable only via a migration (not
 * exported from the schema) fails loudly instead of silently surviving
 * the reset.
 */
const SCHEMA_TABLE_NAMES: readonly string[] = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map((table) => getTableName(table))
  .sort();

const TRUNCATE_ALL_SQL_TEXT = `TRUNCATE TABLE ${SCHEMA_TABLE_NAMES.map(
  (name) => `"${name}"`
).join(', ')} RESTART IDENTITY CASCADE`;

const TRUNCATE_ALL_SQL = sql.raw(TRUNCATE_ALL_SQL_TEXT);

export { SCHEMA_TABLE_NAMES, TRUNCATE_ALL_SQL, TRUNCATE_ALL_SQL_TEXT };
