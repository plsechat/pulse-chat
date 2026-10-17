-- Bridge links: a local channel mirrored to a remote one by an official
-- bridge plugin (webhook token encrypted). Replay-safe: CI applies each
-- migration twice.
CREATE TABLE IF NOT EXISTS "bridge_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"channel_id" integer NOT NULL,
	"remote_guild_id" text NOT NULL,
	"remote_channel_id" text NOT NULL,
	"webhook_id" text,
	"webhook_token_ciphertext" text,
	"direction" text DEFAULT 'both' NOT NULL,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bridge_links_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "bridge_links" ADD CONSTRAINT "bridge_links_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bridge_links_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "bridge_links" ADD CONSTRAINT "bridge_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_links_plugin_channel_idx" ON "bridge_links" USING btree ("plugin_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "bridge_links_plugin_remote_idx" ON "bridge_links" USING btree ("plugin_id","remote_channel_id");