-- Group DM sender-key distribution table. Mirrors e2ee_sender_keys but
-- keyed on dm_channel_id since DM channel IDs and server channel IDs
-- live in different namespaces.
--
-- Idempotent: db/index.ts:27 wipes drizzle.__drizzle_migrations on boot
-- (pulse-issue-migration-pipeline.md), so every CREATE / ALTER guards
-- against re-execution until that's fixed.
CREATE TABLE IF NOT EXISTS "dm_e2ee_sender_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"dm_channel_id" integer NOT NULL,
	"from_user_id" integer NOT NULL,
	"to_user_id" integer NOT NULL,
	"distribution_message" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_e2ee_sender_keys" ADD CONSTRAINT "dm_e2ee_sender_keys_dm_channel_id_dm_channels_id_fk"
		FOREIGN KEY ("dm_channel_id") REFERENCES "public"."dm_channels"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_e2ee_sender_keys" ADD CONSTRAINT "dm_e2ee_sender_keys_from_user_id_users_id_fk"
		FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_e2ee_sender_keys" ADD CONSTRAINT "dm_e2ee_sender_keys_to_user_id_users_id_fk"
		FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_e2ee_sender_keys_channel_idx" ON "dm_e2ee_sender_keys" USING btree ("dm_channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_e2ee_sender_keys_from_idx" ON "dm_e2ee_sender_keys" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_e2ee_sender_keys_to_idx" ON "dm_e2ee_sender_keys" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_e2ee_sender_keys_channel_to_idx" ON "dm_e2ee_sender_keys" USING btree ("dm_channel_id","to_user_id");
