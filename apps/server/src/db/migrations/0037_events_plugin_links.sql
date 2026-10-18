-- Scheduled community events ("raids") with rosters and reusable roster
-- templates, plus the plugin → message link table that lets a plugin edit
-- or delete a message it posted (or mirrored) by its own id. Replay-safe:
-- CI applies each migration twice.
CREATE TABLE IF NOT EXISTS "event_roster_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"roles" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "event_signups" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"role_key" text NOT NULL,
	"status" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"game_tag" text,
	"starts_at" bigint NOT NULL,
	"ends_at" bigint NOT NULL,
	"host_id" integer,
	"template_id" integer,
	"roles" jsonb NOT NULL,
	"max_participants" integer,
	"announce_channel_id" integer,
	"voice_channel_id" integer,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"reminder_stage" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plugin_message_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"plugin_id" text NOT NULL,
	"external_id" text NOT NULL,
	"message_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_roster_templates_server_id_servers_id_fk'
  ) THEN
    ALTER TABLE "event_roster_templates" ADD CONSTRAINT "event_roster_templates_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_signups_event_id_events_id_fk'
  ) THEN
    ALTER TABLE "event_signups" ADD CONSTRAINT "event_signups_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'event_signups_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "event_signups" ADD CONSTRAINT "event_signups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_server_id_servers_id_fk'
  ) THEN
    ALTER TABLE "events" ADD CONSTRAINT "events_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_host_id_users_id_fk'
  ) THEN
    ALTER TABLE "events" ADD CONSTRAINT "events_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_template_id_event_roster_templates_id_fk'
  ) THEN
    ALTER TABLE "events" ADD CONSTRAINT "events_template_id_event_roster_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."event_roster_templates"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_announce_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "events" ADD CONSTRAINT "events_announce_channel_id_channels_id_fk" FOREIGN KEY ("announce_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'events_voice_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "events" ADD CONSTRAINT "events_voice_channel_id_channels_id_fk" FOREIGN KEY ("voice_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plugin_message_links_message_id_messages_id_fk'
  ) THEN
    ALTER TABLE "plugin_message_links" ADD CONSTRAINT "plugin_message_links_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plugin_message_links_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "plugin_message_links" ADD CONSTRAINT "plugin_message_links_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_roster_templates_server_name_idx" ON "event_roster_templates" USING btree ("server_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "event_signups_event_user_idx" ON "event_signups" USING btree ("event_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "event_signups_event_status_idx" ON "event_signups" USING btree ("event_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_server_starts_idx" ON "events" USING btree ("server_id","starts_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_status_starts_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_message_links_plugin_external_idx" ON "plugin_message_links" USING btree ("plugin_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_message_links_message_idx" ON "plugin_message_links" USING btree ("message_id");