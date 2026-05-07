-- Phase B sender-key chains. Adds sender_key_id to both sender-key
-- distribution tables. The sender bumps this column on every chain
-- rotation (kick/leave) so existing rows remain valid for late-
-- arriving messages on the old chain while new messages reference
-- the new chain.
--
-- Idempotent: db/index.ts:27 wipes drizzle.__drizzle_migrations on
-- boot (pulse-issue-migration-pipeline.md), so every ALTER guards
-- against re-execution until that's fixed. Existing rows backfill to
-- senderKeyId = 1 — the only Phase A chain anyone has.
DO $$ BEGIN
	ALTER TABLE "e2ee_sender_keys" ADD COLUMN IF NOT EXISTS "sender_key_id" integer NOT NULL DEFAULT 1;
EXCEPTION
	WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "dm_e2ee_sender_keys" ADD COLUMN IF NOT EXISTS "sender_key_id" integer NOT NULL DEFAULT 1;
EXCEPTION
	WHEN duplicate_column THEN null;
END $$;
