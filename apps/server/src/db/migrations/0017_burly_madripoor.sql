-- Make e2ee_sender_keys deduplication structural rather than reliant
-- on the client behaving. distributeSenderKeysBatch can be called
-- multiple times for the same (channel, from, to, senderKeyId) when
-- two parallel client effects fire — observed on chat2 as duplicate
-- inserts within a single channel-click. Adding a unique index lets
-- the route use ON CONFLICT DO NOTHING so the second call is a no-op.
--
-- Two-step: dedupe pre-existing rows first (keep the lowest id per
-- tuple), then create the unique index. Both wrapped for replay-
-- safety per the boot loop pattern (db/index.ts wipes drizzle
-- migration tracking on every start; pulse-issue-migration-pipeline).
-- See the Postgres error-class cheatsheet in that memory note for
-- why CREATE INDEX raises duplicate_table (42P07) on rerun.

DELETE FROM "e2ee_sender_keys"
WHERE "id" NOT IN (
	SELECT MIN("id")
	FROM "e2ee_sender_keys"
	GROUP BY "channel_id", "from_user_id", "to_user_id", "sender_key_id"
);
--> statement-breakpoint

DO $$ BEGIN
	CREATE UNIQUE INDEX "e2ee_sender_keys_unique_idx"
		ON "e2ee_sender_keys" USING btree
		("channel_id","from_user_id","to_user_id","sender_key_id");
EXCEPTION
	WHEN duplicate_table THEN null;
END $$;
