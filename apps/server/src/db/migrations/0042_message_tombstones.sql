-- Message tombstones: a deleted message keeps its row with deleted_at +
-- deleted_by (content, files, reactions, metadata and pin cleared) and
-- renders as "Message deleted" until the retention sweep hard-deletes it
-- after config.server.tombstoneRetentionDays. The partial indexes serve
-- that sweep (`deleted_at < cutoff`) without indexing the live rows.
-- Replay-safe: CI applies each migration twice.
ALTER TABLE "dm_messages" ADD COLUMN IF NOT EXISTS "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD COLUMN IF NOT EXISTS "deleted_by" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_at" bigint;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "deleted_by" integer;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_messages_deleted_at_idx" ON "dm_messages" USING btree ("deleted_at") WHERE "dm_messages"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_deleted_at_idx" ON "messages" USING btree ("deleted_at") WHERE "messages"."deleted_at" IS NOT NULL;
