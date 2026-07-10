-- Backfill + enforce NOT NULL on channels.public_id / users.public_id.
-- publicId is the globally-unique identifier used for federation-safe
-- addressing — numeric ids are instance-local and collide across federated
-- instances (feature/federation-id-collision). Every insert path already
-- sets it (randomUUIDv7); this guarantees it at the DB level so client and
-- federation code can rely on it always being present.
--
-- Idempotent for the boot-loop replay-safety pattern (db/index.ts wipes
-- drizzle migration tracking on every start): the UPDATEs only touch NULL
-- rows and re-applying SET NOT NULL to an already NOT NULL column is a
-- no-op in Postgres.
UPDATE "channels" SET "public_id" = gen_random_uuid()::text WHERE "public_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "channels" ALTER COLUMN "public_id" SET NOT NULL;
--> statement-breakpoint
UPDATE "users" SET "public_id" = gen_random_uuid()::text WHERE "public_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "public_id" SET NOT NULL;
