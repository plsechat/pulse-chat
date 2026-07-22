ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "screen_max_resolution" text DEFAULT '1080p' NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "screen_max_framerate" integer DEFAULT 60 NOT NULL;
