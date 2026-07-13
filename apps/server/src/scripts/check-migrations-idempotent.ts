/**
 * Migration replay-safety check (defense-in-depth).
 *
 * Migrations run ONCE now: `db/index.ts:loadDb` calls drizzle's
 * `migrate()`, which records applied migrations in
 * `drizzle.__drizzle_migrations` and skips them on later boots. The old
 * boot path wiped that table every start and re-ran everything, which is
 * why migrations used to be forced idempotent (`docker/patch-migrations.ts`).
 *
 * Idempotency is retained as a SAFETY NET, not the primary mechanism:
 * it covers the one residual edge case where an existing database's
 * tracking table is emptied (manual intervention, or a boot that dies
 * mid-migrate), in which case `migrate()` would re-run committed
 * migrations against a populated schema. Keeping the DDL idempotent
 * means that re-run is harmless rather than a crash loop.
 *
 * This script applies every committed migration twice against a clean
 * Postgres; if any DDL re-applies non-idempotently the second pass
 * throws and CI fails on the PR that introduced it. PR #73's
 * `0016_huge_prodigy.sql` shipped with `WHEN duplicate_object` only and
 * crashed the chat2 boot on rebuild — caught by 34af6eb after the fact.
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
  // Wipe drizzle's tracking so migrate() re-runs every migration from
  // scratch. This deliberately does NOT mirror the boot path anymore
  // (which runs each migration once) — it FORCES the re-run so we can
  // verify every migration stays idempotent, the safety net for an
  // existing DB whose tracking table gets emptied.
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
