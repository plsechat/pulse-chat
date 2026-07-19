-- Invite attribution: which invite a member used to join (mod-view
-- "Join Method"). Hand-patched to idempotent form per the replay-safety
-- net (see scripts/check-migrations-idempotent.ts).
ALTER TABLE "server_members" ADD COLUMN IF NOT EXISTS "invite_id" integer;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "server_members" ADD CONSTRAINT "server_members_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
