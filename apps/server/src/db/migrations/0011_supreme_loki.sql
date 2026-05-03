ALTER TABLE "settings" DROP COLUMN "secret_token";--> statement-breakpoint
-- Backfill servers.owner_id for installs that used the legacy secret-token
-- claim flow. Pre-Phase-3 the route only assigned OWNER_ROLE_ID (=1) and never
-- updated servers.owner_id, so these installs would otherwise be treated as
-- ownerless and the next-registered user would claim ownership.
UPDATE "servers"
SET "owner_id" = (
  SELECT "user_id" FROM "user_roles"
  WHERE "role_id" = 1
  ORDER BY "created_at" ASC
  LIMIT 1
)
WHERE "id" = 1 AND "owner_id" IS NULL;
