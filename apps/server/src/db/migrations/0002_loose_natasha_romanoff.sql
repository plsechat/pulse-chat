ALTER TABLE "dm_messages" ADD COLUMN "type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "type" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "server_members" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;