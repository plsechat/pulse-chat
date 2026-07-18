import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '../config';
import { DRIZZLE_PATH } from '../helpers/paths';
import { logger } from '../logger';
import { seedDatabase } from './seed';

let db: PostgresJsDatabase;

const loadDb = async () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL environment variable');
  }

  const client = postgres(databaseUrl);

  db = drizzle({
    client,
    // Drizzle's logger fires before each query is sent. It's a
    // pre-execution hook — we don't get the elapsed time here, so
    // queries are emitted at debug level only when verbose logging
    // is on. A proper slow-query hook (with timing past a threshold)
    // needs a postgres-js / drizzle wrapper that intercepts the
    // response, deferred.
    //
    // Pre-format the message rather than using winston's printf-style
    // %s/%o splat: when winston applies `Object.assign(info, ...args)`
    // for the meta merge, a long string argument spreads char-by-char
    // as numeric-keyed properties (info[0]='s', info[1]='e', ...) and
    // pollutes the JSON. A single concatenated string keeps the JSON
    // payload to {level, message, requestId, ...}.
    logger: config.server.debug
      ? {
          logQuery: (query, params) => {
            const truncated =
              query.length > 200 ? `${query.slice(0, 200)}…` : query;
            const paramsStr = JSON.stringify(params);
            logger.debug(`[db/query] ${truncated} params=${paramsStr}`);
          }
        }
      : false
  });

  // Serialize migration across concurrently-booting instances so two
  // replicas don't race `migrate()` against the same database.
  const MIGRATION_LOCK_ID = 827394827;

  await client`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
  try {
    // Run migrations the normal drizzle way: `migrate()` records applied
    // migrations in `drizzle.__drizzle_migrations` and, on each boot,
    // runs only those newer than the last recorded one (it compares the
    // journal's `when` timestamp against the table's max `created_at`).
    //
    // We do NOT wipe that tracking table. The old boot path deleted it
    // every start, forcing every migration to re-run on every restart —
    // which is why they all had to be hand-written idempotent. Deleting
    // it defeated the exact bookkeeping that makes migrations run once,
    // and made one-shot data migrations (backfills, NOT NULL enforcement)
    // silently re-execute forever. Migrations now run once, in order.
    // Idempotency (docker/patch-migrations.ts) is retained only as a
    // safety net for the rare case of an existing DB with an emptied
    // tracking table — not as the primary mechanism.
    await migrate(db, { migrationsFolder: DRIZZLE_PATH });
    await seedDatabase();
  } finally {
    await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }

  // publicId backfill for users/channels now lives in migration
  // 0019_public_id_not_null (backfill + NOT NULL enforcement), which runs
  // before we get here — the app-level backfill loops that used to sit
  // at this point can no longer find NULL rows and were removed.
};

export { db, loadDb };
