-- Local-auth refresh-token sessions: one row per refresh token the local
-- backend mints, grouped into families (sign-in + every rotation). Gives
-- the backend something to revoke on logout, password change and
-- refresh-token reuse. Replay-safe: CI applies each migration twice.
CREATE TABLE IF NOT EXISTS "local_auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"family_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"replaced_by" text
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'local_auth_sessions_user_id_local_auth_users_id_fk'
  ) THEN
    ALTER TABLE "local_auth_sessions" ADD CONSTRAINT "local_auth_sessions_user_id_local_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."local_auth_users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_auth_sessions_user_idx" ON "local_auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "local_auth_sessions_family_idx" ON "local_auth_sessions" USING btree ("family_id");
