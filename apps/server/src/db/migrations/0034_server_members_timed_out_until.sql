-- Automod `timeout_user`: a per-membership deadline (epoch ms) during
-- which the member can neither send messages nor join voice in that
-- server. NULL / past = not timed out. MANAGE_USERS holders bypass.
ALTER TABLE "server_members" ADD COLUMN IF NOT EXISTS "timed_out_until" bigint;
