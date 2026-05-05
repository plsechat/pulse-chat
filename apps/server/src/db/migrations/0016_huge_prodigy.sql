-- Phase E / E1 — federation-spanning identifier for server channels.
-- Required for cross-instance SKDM addressing in encrypted federated
-- channels: the host instance addresses recipients by (channel
-- publicId, recipient publicId) so receiver instances can identify
-- the right channel without leaking host-local integer ids.
--
-- publicId stays nullable here. Existing channel rows are backfilled
-- by db/index.ts at boot (mirrors the users.publicId pattern), and
-- new channels populate it on creation in the channel-create routes.
--
-- Idempotent: db/index.ts wipes drizzle's migration tracking on every
-- boot (pulse-issue-migration-pipeline), so each statement guards
-- against re-execution.

DO $$ BEGIN
	ALTER TABLE "channels" ADD COLUMN "public_id" text;
EXCEPTION
	WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
	CREATE UNIQUE INDEX "channels_public_id_idx" ON "channels" USING btree ("public_id");
EXCEPTION
	WHEN duplicate_table THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
	ALTER TABLE "channels" ADD CONSTRAINT "channels_public_id_unique" UNIQUE("public_id");
EXCEPTION
	-- ADD CONSTRAINT … UNIQUE creates a backing index. Re-running the
	-- migration after a successful first pass therefore raises 42P07
	-- (duplicate_table) for the index, not 42710 (duplicate_object) for
	-- the constraint. Catch both so the boot-time replay is idempotent.
	WHEN duplicate_object THEN null;
	WHEN duplicate_table THEN null;
END $$;
