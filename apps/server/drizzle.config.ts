import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  // Same folder the db:gen script and check-migrations-idempotent use.
  // The runtime migrator reads DATA_PATH/drizzle instead — migrations are
  // copied there at build/package time (see build/build.ts drizzle.zip).
  out: './src/db/migrations',
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL!
  }
});
