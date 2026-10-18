import { describe, expect, test } from 'bun:test';
import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';
import { channels, messages, roles, settings, users } from '../db/schema';
import { tdb } from './setup';
import { SCHEMA_TABLE_NAMES, TRUNCATE_ALL_SQL_TEXT } from './truncate';

describe('tests setup', () => {
  test('should seed database with initial data', async () => {
    const [
      settingsResults,
      usersResults,
      channelsResults,
      rolesResults,
      messagesResults
    ] = await Promise.all([
      tdb.select().from(settings),
      tdb.select().from(users),
      tdb.select().from(channels),
      tdb.select().from(roles),
      tdb.select().from(messages)
    ]);

    expect(settingsResults.length).toBe(1);
    expect(usersResults.length).toBe(3);
    expect(channelsResults.length).toBe(2);
    expect(rolesResults.length).toBe(3);
    expect(messagesResults.length).toBe(1);
  });

  test('between-test TRUNCATE covers every pgTable exported by the schema', () => {
    const exported = (Object.values(schema) as unknown[])
      .filter((value): value is PgTable => is(value, PgTable))
      .map((table) => getTableName(table));

    expect(exported.length).toBeGreaterThan(0);
    for (const name of exported) {
      expect(SCHEMA_TABLE_NAMES).toContain(name);
      expect(TRUNCATE_ALL_SQL_TEXT).toContain(`"${name}"`);
    }

    // The three tables the old hand-maintained lists had drifted away
    // from. `local_auth_users` has no FK, so CASCADE never reached it.
    expect(SCHEMA_TABLE_NAMES).toContain('local_auth_users');
    expect(SCHEMA_TABLE_NAMES).toContain('nameplates');
    expect(SCHEMA_TABLE_NAMES).toContain('user_blocks');
  });

  test('every table in the test database is a schema table (and vice versa)', async () => {
    // A table created by a migration but not exported from db/schema.ts
    // would survive the reset — catch it here rather than as a flaky
    // duplicate-key failure three files later.
    const rows = (await tdb.execute(sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `)) as unknown as { table_name: string }[];
    const inDatabase = rows.map((r) => r.table_name).sort();

    expect(inDatabase).toEqual([...SCHEMA_TABLE_NAMES]);
  });
});
