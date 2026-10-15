-- Local-auth users table — populated only when AUTH_BACKEND=local.
-- The id stored here is what gets placed on `users.supabaseId` when
-- registerUser runs after createUser. Empty in supabase mode.
--
-- Idempotent: drizzle tracking runs this once; the IF NOT EXISTS /
-- exception guards are the safety net for a replay, which CI exercises
-- by applying every migration twice (migrations-idempotent job,
-- scripts/check-migrations-idempotent.ts).

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
