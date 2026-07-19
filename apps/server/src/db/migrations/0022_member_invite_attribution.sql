-- Invite attribution: record which invite a member used to join, powering
-- the mod-view "Join Method" row (invite code + inviter).
--
-- Idempotent for the boot-loop replay-safety pattern (db/index.ts wipes
-- drizzle migration tracking on every start): ADD COLUMN IF NOT EXISTS and
-- a duplicate_object-guarded constraint are no-ops on re-run.
ALTER TABLE "server_members" ADD COLUMN IF NOT EXISTS "invite_id" integer;
DO $$ BEGIN
  ALTER TABLE "server_members" ADD CONSTRAINT "server_members_invite_id_invites_id_fk"
    FOREIGN KEY ("invite_id") REFERENCES "invites"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
