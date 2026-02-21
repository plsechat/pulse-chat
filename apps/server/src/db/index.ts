import { randomUUIDv7 } from 'bun';
import { eq, isNull } from 'drizzle-orm';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { DRIZZLE_PATH } from '../helpers/paths';
import { seedDatabase } from './seed';
import { users } from './schema';

let db: PostgresJsDatabase;

const loadDb = async () => {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('Missing DATABASE_URL environment variable');
  }

  const client = postgres(databaseUrl);

  db = drizzle({ client });

  // Clear Drizzle migration tracking so migrations re-run from scratch.
  // All migration SQL is patched to be idempotent (IF NOT EXISTS, etc.)
  // so re-applying is always safe and prevents hash mismatch errors.
  await client`DELETE FROM drizzle.__drizzle_migrations`.catch(() => {});

  await migrate(db, { migrationsFolder: DRIZZLE_PATH });
  await seedDatabase();

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
};

export { db, loadDb };
