-- Immutable forward attribution on both message tables: the server
-- derives forwarded_from_user_id from the SOURCE message at send time
-- (never client-claimed); forwarded_from_name is a display snapshot
-- that survives author deletion and shadow-user renames. The edit
-- routes never touch these columns.
--
-- Idempotent by project convention (enforced by
-- scripts/check-migrations-idempotent.ts): ADD COLUMN IF NOT EXISTS,
-- FK constraints swallow duplicate_object.
ALTER TABLE "dm_messages" ADD COLUMN IF NOT EXISTS "forwarded_from_user_id" integer;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD COLUMN IF NOT EXISTS "forwarded_from_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "forwarded_from_user_id" integer;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "forwarded_from_name" text;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_forwarded_from_user_id_users_id_fk"
    FOREIGN KEY ("forwarded_from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_forwarded_from_user_id_users_id_fk"
    FOREIGN KEY ("forwarded_from_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
