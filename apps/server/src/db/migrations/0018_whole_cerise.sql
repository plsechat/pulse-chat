-- Local-auth users table — populated only when AUTH_BACKEND=local.
-- The id stored here is what gets placed on `users.supabaseId` when
-- registerUser runs after createUser. Empty in supabase mode.
--
-- Idempotent for the boot-loop replay-safety pattern (db/index.ts wipes
-- drizzle migration tracking on every start). See migration-pipeline
-- gotcha + the migrations-idempotent CI job.

CREATE TABLE IF NOT EXISTS "local_auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"identities" text DEFAULT '[{"provider":"email"}]' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint

DO $$ BEGIN
	CREATE UNIQUE INDEX "local_auth_users_email_idx"
		ON "local_auth_users" USING btree ("email");
EXCEPTION
	WHEN duplicate_table THEN null;
END $$;
