-- Add user_blocks table backing the symmetric block feature. Both rows
-- (blocker → blocked) drive a two-way visibility cut: when either user
-- has a row pointing at the other, DM/friend-request/message paths
-- treat them as mutually invisible.
--
-- Idempotent: db/index.ts:27 wipes drizzle.__drizzle_migrations every
-- boot (pulse-issue-migration-pipeline.md), so this re-runs on every
-- restart. CREATE TABLE / CREATE INDEX use IF NOT EXISTS to stay
-- replay-safe until that's fixed.
CREATE TABLE IF NOT EXISTS "user_blocks" (
  "id" serial PRIMARY KEY NOT NULL,
  "blocker_id" integer NOT NULL,
  "blocked_user_id" integer NOT NULL,
  "created_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk"
    FOREIGN KEY ("blocker_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_user_id_users_id_fk"
    FOREIGN KEY ("blocked_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_blocks_blocker_idx" ON "user_blocks" USING btree ("blocker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_blocks_blocked_idx" ON "user_blocks" USING btree ("blocked_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_blocks_pair_idx" ON "user_blocks" USING btree ("blocker_id","blocked_user_id");
