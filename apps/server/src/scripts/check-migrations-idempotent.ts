/**
 * Migration replay-safety check.
 *
 * The PULSE boot path (`db/index.ts:loadDb`) wipes drizzle's
 * `__drizzle_migrations` tracking table on every start and re-runs
 * every committed migration. That works only because each migration
 * SQL file is hand-written to be idempotent — `CREATE TABLE IF NOT
 * EXISTS`, `ADD COLUMN IF NOT EXISTS`, or `DO $$ … EXCEPTION WHEN
 * duplicate_<class> THEN null; END $$` blocks.
 *
 * CI uses a fresh Postgres for every test run, so the rerun path
 * never fires there — non-idempotent migrations slip through review
 * and only crash on dev/prod restarts. PR #73's `0016_huge_prodigy.sql`
 * shipped with `WHEN duplicate_object` only and crashed the chat2
 * boot on rebuild — caught by 34af6eb after the fact.
 *
 * This script applies every committed migration twice in a row
 * against a clean Postgres. The second pass is the same operation
 * the boot loop performs on every restart of an existing instance.
 * If any DDL re-applies non-idempotently, the second pass throws
 * and the script exits non-zero — failing CI on the PR that
 * introduced the regression.
 *
 * Invoked by `.github/workflows/test.yml` (`migrations-idempotent`
 * job) on every push and pull request. Local invocation works too:
 *
 *   DATABASE_URL=postgresql://... bun run apps/server/src/scripts/check-migrations-idempotent.ts
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('[check-migrations] DATABASE_URL is required');
  process.exit(1);
}

// Resolve `src/db/migrations` relative to this file regardless of cwd.
// `import.meta.dirname` is `src/scripts` at runtime under bun.
const migrationsFolder = path.resolve(import.meta.dirname, '../db/migrations');

const client = postgres(databaseUrl);
const db = drizzle({ client });

async function pass(label: string): Promise<void> {
  // Mirror `db/index.ts:loadDb` — wipe drizzle's tracking, then
  // migrate from scratch. The wipe is what forces the rerun on every
  // boot, and is exactly the production behaviour we need to verify.
  await client`DELETE FROM drizzle.__drizzle_migrations`.catch(() => {});
  await migrate(db, { migrationsFolder });
  console.log(`[check-migrations] ${label} pass OK`);
}

try {
  await pass('first');
  await pass('second');
  console.log(
    '[check-migrations] migrations are replay-safe (two passes succeeded)'
  );
} catch (e) {
  console.error('[check-migrations] migration replay failed:');
  console.error(e);
  process.exit(1);
} finally {
  await client.end();
}
