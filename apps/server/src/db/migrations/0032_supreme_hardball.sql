-- Schema integrity round (audit A6-25 / A6-13 / A4-18).
--
-- Every statement is replay-safe: CI applies each migration twice
-- (scripts/check-migrations-idempotent.ts). Constraints are guarded on
-- pg_constraint, indexes with IF (NOT) EXISTS, and the dangling-row
-- cleanups are plain DELETE/UPDATE on predicates that match nothing once
-- the FK exists.
--
-- 1. servers.owner_id: ON DELETE SET NULL -> RESTRICT. A null owner
--    re-opens the bootstrap "first registrant becomes owner" claim, so a
--    hard delete of an owner row must fail instead of handing the server
--    to the next sign-up. Drop the old constraint ONLY while it still
--    cascades as SET NULL (confdeltype 'n'); re-add when absent.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'servers_owner_id_users_id_fk' AND confdeltype <> 'r'
  ) THEN
    ALTER TABLE "servers" DROP CONSTRAINT "servers_owner_id_users_id_fk";
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'servers_owner_id_users_id_fk'
  ) THEN
    ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- 2. settings gets a real primary key on server_id (the unique index it
--    replaces was the only thing stopping a second row).
DROP INDEX IF EXISTS "settings_server_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "settings_server_unique_idx";--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = '"settings"'::regclass AND contype = 'p'
  ) THEN
    ALTER TABLE "settings" ADD PRIMARY KEY ("server_id");
  END IF;
END $$;--> statement-breakpoint
-- 3. Missing foreign keys. Each one is preceded by a cleanup of rows that
--    already dangle on an existing install, applying the same rule the
--    constraint will enforce from now on (CASCADE -> delete the child,
--    SET NULL -> null the column), so ADD CONSTRAINT cannot fail
--    validation.
--
-- channels.parent_channel_id -> channels (threads die with the parent).
DELETE FROM "channels" c
WHERE c."parent_channel_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "channels" p WHERE p."id" = c."parent_channel_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_parent_channel_id_channels_id_fk'
  ) THEN
    ALTER TABLE "channels" ADD CONSTRAINT "channels_parent_channel_id_channels_id_fk" FOREIGN KEY ("parent_channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- dm_messages.reply_to_id -> dm_messages (reply to a deleted message).
UPDATE "dm_messages" m SET "reply_to_id" = NULL
WHERE m."reply_to_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "dm_messages" t WHERE t."id" = m."reply_to_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'dm_messages_reply_to_id_dm_messages_id_fk'
  ) THEN
    ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_reply_to_id_dm_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."dm_messages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- files.user_id -> users (uploads die with a hard-deleted uploader;
-- message_files/emojis cascade from files, avatar/logo columns null).
DELETE FROM "files" f
WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u."id" = f."user_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'files_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "files" ADD CONSTRAINT "files_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- messages.reply_to_id -> messages.
UPDATE "messages" m SET "reply_to_id" = NULL
WHERE m."reply_to_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "messages" t WHERE t."id" = m."reply_to_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_reply_to_id_messages_id_fk'
  ) THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- messages.webhook_id -> webhooks (message outlives its webhook).
UPDATE "messages" m SET "webhook_id" = NULL
WHERE m."webhook_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "webhooks" w WHERE w."id" = m."webhook_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_webhook_id_webhooks_id_fk'
  ) THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- users.federated_instance_id -> federation_instances (shadow users of a
-- removed peer lose the instance link, keep their rows and messages).
UPDATE "users" u SET "federated_instance_id" = NULL
WHERE u."federated_instance_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "federation_instances" i WHERE i."id" = u."federated_instance_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_federated_instance_id_federation_instances_id_fk'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_federated_instance_id_federation_instances_id_fk" FOREIGN KEY ("federated_instance_id") REFERENCES "public"."federation_instances"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
-- 4. DM sender-key rows get the same unique tuple as the channel table
--    (0017). Duplicates from the non-single-flight client path are
--    collapsed to the newest row (highest id) before the index exists.
DELETE FROM "dm_e2ee_sender_keys" a
USING "dm_e2ee_sender_keys" b
WHERE a."dm_channel_id" = b."dm_channel_id"
  AND a."from_user_id" = b."from_user_id"
  AND a."to_user_id" = b."to_user_id"
  AND a."sender_key_id" = b."sender_key_id"
  AND a."id" < b."id";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_e2ee_sender_keys_unique_idx" ON "dm_e2ee_sender_keys" USING btree ("dm_channel_id","from_user_id","to_user_id","sender_key_id");--> statement-breakpoint
-- 5. Hot-path indexes: the orphan-file scan probes every file-reference
--    column, unread counts filter (channel_id, id), mention counts use a
--    jsonb containment on mentioned_user_ids.
CREATE INDEX IF NOT EXISTS "dm_channels_icon_file_idx" ON "dm_channels" USING btree ("icon_file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dm_reaction_file_idx" ON "dm_message_reactions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reaction_file_idx" ON "message_reactions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_channel_id_idx" ON "messages" USING btree ("channel_id","id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_mentioned_users_idx" ON "messages" USING gin ("mentioned_user_ids");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_avatar_idx" ON "users" USING btree ("avatar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_banner_idx" ON "users" USING btree ("banner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhooks_avatar_file_idx" ON "webhooks" USING btree ("avatar_file_id");
