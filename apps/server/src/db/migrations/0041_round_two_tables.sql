-- Round-two feature tables: polls and votes, scheduled posts (with a real
-- file link so the orphan scan sees their uploads), announcement follows,
-- soundboard sounds, the federated directory cache (with the peer's
-- password flag), plus the announcement flag, directory listing fields,
-- game presence and persisted bridge sync reports. Replay-safe: CI
-- applies each migration twice.
CREATE TABLE IF NOT EXISTS "channel_follows" (
	"id" serial PRIMARY KEY NOT NULL,
	"source_channel_id" integer,
	"source_instance_id" integer,
	"source_channel_public_id" text,
	"target_channel_id" integer,
	"target_instance_id" integer,
	"target_channel_public_id" text,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "directory_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"server_public_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tags" jsonb,
	"game" text,
	"member_count" integer DEFAULT 0 NOT NULL,
	"online_count" integer DEFAULT 0 NOT NULL,
	"logo_url" text,
	"has_password" boolean DEFAULT false NOT NULL,
	"fetched_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "poll_votes" (
	"id" serial PRIMARY KEY NOT NULL,
	"poll_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"option_key" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "polls" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"question" text NOT NULL,
	"options" jsonb NOT NULL,
	"multiple" boolean DEFAULT false NOT NULL,
	"anonymous" boolean DEFAULT false NOT NULL,
	"closes_at" bigint,
	"closed_at" bigint,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_post_files" (
	"scheduled_post_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "scheduled_post_files_scheduled_post_id_file_id_pk" PRIMARY KEY("scheduled_post_id","file_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scheduled_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"content" text NOT NULL,
	"send_at" bigint NOT NULL,
	"sent_message_id" integer,
	"cancelled_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_sounds" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"file_id" integer NOT NULL,
	"emoji" text,
	"volume" integer DEFAULT 100 NOT NULL,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bridge_server_links" ADD COLUMN IF NOT EXISTS "last_sync_at" bigint;--> statement-breakpoint
ALTER TABLE "bridge_server_links" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "bridge_server_links" ADD COLUMN IF NOT EXISTS "last_report" jsonb;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "announcement" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "directory_listed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "directory_description" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "directory_tags" jsonb;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "directory_game" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "game_presence" jsonb;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_follows_source_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "channel_follows" ADD CONSTRAINT "channel_follows_source_channel_id_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_follows_source_instance_id_federation_instances_id_fk'
  ) THEN
    ALTER TABLE "channel_follows" ADD CONSTRAINT "channel_follows_source_instance_id_federation_instances_id_fk" FOREIGN KEY ("source_instance_id") REFERENCES "public"."federation_instances"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_follows_target_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "channel_follows" ADD CONSTRAINT "channel_follows_target_channel_id_channels_id_fk" FOREIGN KEY ("target_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_follows_target_instance_id_federation_instances_id_fk'
  ) THEN
    ALTER TABLE "channel_follows" ADD CONSTRAINT "channel_follows_target_instance_id_federation_instances_id_fk" FOREIGN KEY ("target_instance_id") REFERENCES "public"."federation_instances"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_follows_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "channel_follows" ADD CONSTRAINT "channel_follows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'directory_cache_instance_id_federation_instances_id_fk'
  ) THEN
    ALTER TABLE "directory_cache" ADD CONSTRAINT "directory_cache_instance_id_federation_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."federation_instances"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'poll_votes_poll_id_polls_id_fk'
  ) THEN
    ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_poll_id_polls_id_fk" FOREIGN KEY ("poll_id") REFERENCES "public"."polls"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'poll_votes_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "poll_votes" ADD CONSTRAINT "poll_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'polls_message_id_messages_id_fk'
  ) THEN
    ALTER TABLE "polls" ADD CONSTRAINT "polls_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'polls_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "polls" ADD CONSTRAINT "polls_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'polls_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "polls" ADD CONSTRAINT "polls_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_post_files_scheduled_post_id_scheduled_posts_id_fk'
  ) THEN
    ALTER TABLE "scheduled_post_files" ADD CONSTRAINT "scheduled_post_files_scheduled_post_id_scheduled_posts_id_fk" FOREIGN KEY ("scheduled_post_id") REFERENCES "public"."scheduled_posts"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_post_files_file_id_files_id_fk'
  ) THEN
    ALTER TABLE "scheduled_post_files" ADD CONSTRAINT "scheduled_post_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_posts_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_posts_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_posts_sent_message_id_messages_id_fk'
  ) THEN
    ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_sent_message_id_messages_id_fk" FOREIGN KEY ("sent_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'server_sounds_server_id_servers_id_fk'
  ) THEN
    ALTER TABLE "server_sounds" ADD CONSTRAINT "server_sounds_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'server_sounds_file_id_files_id_fk'
  ) THEN
    ALTER TABLE "server_sounds" ADD CONSTRAINT "server_sounds_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'server_sounds_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "server_sounds" ADD CONSTRAINT "server_sounds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_follows_local_idx" ON "channel_follows" USING btree ("source_channel_id","target_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_follows_remote_source_idx" ON "channel_follows" USING btree ("source_instance_id","source_channel_public_id","target_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_follows_remote_target_idx" ON "channel_follows" USING btree ("source_channel_id","target_instance_id","target_channel_public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_follows_source_idx" ON "channel_follows" USING btree ("source_channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "channel_follows_target_idx" ON "channel_follows" USING btree ("target_channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "directory_cache_instance_server_idx" ON "directory_cache" USING btree ("instance_id","server_public_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "directory_cache_game_idx" ON "directory_cache" USING btree ("game");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "poll_votes_poll_user_option_idx" ON "poll_votes" USING btree ("poll_id","user_id","option_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "poll_votes_poll_idx" ON "poll_votes" USING btree ("poll_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "polls_message_idx" ON "polls" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polls_channel_idx" ON "polls" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "polls_closes_idx" ON "polls" USING btree ("closes_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_post_files_file_idx" ON "scheduled_post_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_posts_channel_idx" ON "scheduled_posts" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_posts_user_idx" ON "scheduled_posts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "scheduled_posts_send_at_idx" ON "scheduled_posts" USING btree ("send_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "server_sounds_server_name_idx" ON "server_sounds" USING btree ("server_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "server_sounds_file_idx" ON "server_sounds" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "servers_directory_listed_idx" ON "servers" USING btree ("directory_listed");