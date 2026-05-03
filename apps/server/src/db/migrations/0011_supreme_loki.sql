-- Idempotent: db/index.ts:27 deletes drizzle.__drizzle_migrations on every
-- boot, so this migration re-runs every restart. The first run drops the
-- column; subsequent runs would error without IF EXISTS and brick the
-- container (this is the pulse-issue-migration-pipeline.md tracking item;
-- IF EXISTS here is the workaround until that's fixed properly).
ALTER TABLE "settings" DROP COLUMN IF EXISTS "secret_token";--> statement-breakpoint
-- Backfill servers.owner_id for installs that used the legacy secret-token
-- claim flow. Pre-Phase-3 the route only assigned OWNER_ROLE_ID (=1) and never
-- updated servers.owner_id, so these installs would otherwise be treated as
-- ownerless and the next-registered user would claim ownership. Safe to
-- re-run: the WHERE clause skips rows that already have owner_id set.
UPDATE "servers"
SET "owner_id" = (
  SELECT "user_id" FROM "user_roles"
  WHERE "role_id" = 1
  ORDER BY "created_at" ASC
  LIMIT 1
)
WHERE "id" = 1 AND "owner_id" IS NULL;
