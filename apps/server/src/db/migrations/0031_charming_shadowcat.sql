-- Role hierarchy: every role gets a rank within its server. Higher
-- position = more senior; the owner role is the highest, the default
-- role the lowest. Routes only let a caller touch roles STRICTLY below
-- their own highest role (the server owner bypasses the ceiling).
ALTER TABLE "roles" ADD COLUMN IF NOT EXISTS "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "roles_server_position_idx" ON "roles" USING btree ("server_id","position");--> statement-breakpoint
-- Backfill, once per server: the default role stays at 0, the custom
-- (non-persistent) roles get 1..n with the OLDEST role (lowest id) on
-- top — that is the precedence the client has always shown — and the
-- owner role (persistent, non-default) lands above all of them.
-- A server is only backfilled while every one of its roles still sits
-- at the column default, so a second run (CI applies each migration
-- twice) and a server that was already ranked are left untouched.
WITH custom AS (
  SELECT "id", "server_id",
         ROW_NUMBER() OVER (PARTITION BY "server_id" ORDER BY "id" DESC) AS rn
  FROM "roles"
  WHERE NOT "is_persistent" AND NOT "is_default"
), counts AS (
  SELECT "server_id", count(*) AS n FROM custom GROUP BY "server_id"
), fresh AS (
  SELECT "server_id" FROM "roles" GROUP BY "server_id" HAVING bool_and("position" = 0)
)
UPDATE "roles" r
SET "position" = CASE
  WHEN r."is_default" THEN 0
  WHEN r."is_persistent" THEN COALESCE((SELECT n FROM counts WHERE counts."server_id" = r."server_id"), 0) + 1
  ELSE COALESCE((SELECT rn FROM custom WHERE custom."id" = r."id"), 0)
END
WHERE r."server_id" IN (SELECT "server_id" FROM fresh);
