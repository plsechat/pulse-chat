-- Whole-server bridge links and the per-channel link columns that tie a
-- pair to its server link or opt it out. Replay-safe: CI applies each
-- migration twice.
CREATE TABLE IF NOT EXISTS "bridge_server_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"server_id" integer NOT NULL,
	"remote_guild_id" text NOT NULL,
	"mode" text DEFAULT 'match' NOT NULL,
	"create_missing" text DEFAULT 'none' NOT NULL,
	"default_direction" text DEFAULT 'both' NOT NULL,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_links" ADD COLUMN IF NOT EXISTS "server_link_id" integer;--> statement-breakpoint
ALTER TABLE "bridge_links" ADD COLUMN IF NOT EXISTS "excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bridge_server_links_server_id_servers_id_fk'
  ) THEN
    ALTER TABLE "bridge_server_links" ADD CONSTRAINT "bridge_server_links_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bridge_server_links_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "bridge_server_links" ADD CONSTRAINT "bridge_server_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_server_links_plugin_server_idx" ON "bridge_server_links" USING btree ("plugin_id","server_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_server_links_plugin_guild_idx" ON "bridge_server_links" USING btree ("plugin_id","remote_guild_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bridge_links_server_link_id_bridge_server_links_id_fk'
  ) THEN
    ALTER TABLE "bridge_links" ADD CONSTRAINT "bridge_links_server_link_id_bridge_server_links_id_fk" FOREIGN KEY ("server_link_id") REFERENCES "public"."bridge_server_links"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;