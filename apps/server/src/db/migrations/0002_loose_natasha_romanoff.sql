ALTER TABLE "dm_messages" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN IF NOT EXISTS "position" integer DEFAULT 0 NOT NULL;