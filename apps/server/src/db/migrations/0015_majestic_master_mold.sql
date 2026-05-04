-- Phase D / D2 — federation-spanning identifier for group DMs that
-- include members across instances. Only group DMs (`is_group=true`)
-- with at least one federated member populate this column; same-
-- instance groups and 1:1 DMs leave it NULL. Each peer instance's
-- mirror channel for the same logical group has the same UUID, so
-- inbound dm-relay (group messages) and dm-sender-key (SKDMs) can
-- look up the local mirror by ID instead of trying to recompute
-- "the group between these N members," which doesn't generalise
-- across instances.
--
-- Idempotent: db/index.ts wipes drizzle's migration tracking on every
-- boot (pulse-issue-migration-pipeline), so the ALTER + CREATE INDEX
-- guard against re-execution.

DO $$ BEGIN
	ALTER TABLE "dm_channels" ADD COLUMN "federation_group_id" text;
EXCEPTION
	WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint

DO $$ BEGIN
	CREATE INDEX "dm_channels_federation_group_id_idx" ON "dm_channels" USING btree ("federation_group_id");
EXCEPTION
	WHEN duplicate_table THEN null;
END $$;
