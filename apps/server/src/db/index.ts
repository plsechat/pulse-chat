import { randomUUIDv7 } from 'bun';
import { eq, isNull } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { config } from '../config';
import { DRIZZLE_PATH } from '../helpers/paths';
import { logger } from '../logger';
import { seedDatabase } from './seed';
import { channels, users } from './schema';

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

  const MIGRATION_LOCK_ID = 827394827;

  await client`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`;
  try {
    await client`DELETE FROM drizzle.__drizzle_migrations`.catch(() => { });
    await migrate(db, { migrationsFolder: DRIZZLE_PATH });
    await seedDatabase();
  } finally {
    await client`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`;
  }

  // Backfill publicId for existing users that don't have one
  const usersWithoutPublicId = await db
    .select({ id: users.id })
    .from(users)
    .where(isNull(users.publicId));

  for (const user of usersWithoutPublicId) {
    await db
      .update(users)
      .set({ publicId: randomUUIDv7() })
      .where(eq(users.id, user.id));
  }

  // Backfill publicId for existing channels that don't have one.
  // Phase E / E1 — channels need a federation-spanning identifier so
  // cross-instance SKDM addressing can reference the right channel
  // without leaking host-local integer ids.
  const channelsWithoutPublicId = await db
    .select({ id: channels.id })
    .from(channels)
    .where(isNull(channels.publicId));

  for (const channel of channelsWithoutPublicId) {
    await db
      .update(channels)
      .set({ publicId: randomUUIDv7() })
      .where(eq(channels.id, channel.id));
  }
};

export { db, loadDb };
