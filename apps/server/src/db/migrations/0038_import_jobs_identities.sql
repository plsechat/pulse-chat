-- Community import jobs (resumable, token erased at the end) and external
-- identities (placeholder authors claimed on sign-in). Replay-safe: CI
-- applies each migration twice.
CREATE TABLE IF NOT EXISTS "external_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"placeholder" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"created_by" integer,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"step" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"token_ciphertext" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'external_identities_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_jobs_server_id_servers_id_fk'
  ) THEN
    ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_jobs_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_identities_provider_external_idx" ON "external_identities" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_identities_user_idx" ON "external_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_jobs_server_status_idx" ON "import_jobs" USING btree ("server_id","status");