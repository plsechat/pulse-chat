-- Profile fields: pronouns + custom-status emoji + custom-status expiry.
--
-- Idempotent for the boot-loop replay-safety pattern (db/index.ts wipes
-- drizzle migration tracking on every start): ADD COLUMN IF NOT EXISTS is
-- a no-op on re-run.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "pronouns" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_status_emoji" text;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "custom_status_expires_at" bigint;
