-- Nameplates: decorative member-row backgrounds. users.nameplate holds
-- 'preset:<slug>' or 'custom:<id>'; the nameplates table stores the
-- admin-uploaded image packs. Hand-patched to idempotent form per the
-- replay-safety net (see scripts/check-migrations-idempotent.ts).
CREATE TABLE IF NOT EXISTS "nameplates" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"file_id" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "nameplate" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "nameplates" ADD CONSTRAINT "nameplates_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "nameplates" ADD CONSTRAINT "nameplates_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nameplates_server_idx" ON "nameplates" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "nameplates_file_idx" ON "nameplates" USING btree ("file_id");
