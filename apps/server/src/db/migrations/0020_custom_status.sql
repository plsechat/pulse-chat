-- Custom status text ("🎧 working late") — persisted presence line on the
-- user profile, distinct from the runtime-only ONLINE/IDLE/DND status.
--
-- Idempotent for the boot-loop replay-safety pattern (db/index.ts wipes
-- drizzle migration tracking on every start): ADD COLUMN IF NOT EXISTS
-- is a no-op on re-run.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_status" text;
