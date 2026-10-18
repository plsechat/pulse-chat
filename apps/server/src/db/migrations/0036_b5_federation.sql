-- Federation hardening (audit batch B5): durable relay outbox, restart-safe
-- replay cache, shadow identity keyed by (instance, publicId), canonical
-- 1:1 DM pair key, relay idempotency id, peer compat signal, key-rotation
-- grace (ours and the peer's), federated report source. Replay-safe: CI
-- applies each migration twice.
CREATE TABLE IF NOT EXISTS "federation_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"instance_id" integer NOT NULL,
	"path" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" bigint NOT NULL,
	"last_error" text,
	"created_at" bigint NOT NULL,
	"dead_at" bigint
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "federation_seen_jti" (
	"jti" text PRIMARY KEY NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
DROP INDEX IF EXISTS "users_federated_identity_idx";--> statement-breakpoint
ALTER TABLE "dm_channels" ADD COLUMN IF NOT EXISTS "pair_key" text;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD COLUMN IF NOT EXISTS "federation_relay_id" text;--> statement-breakpoint
ALTER TABLE "federation_instances" ADD COLUMN IF NOT EXISTS "peer_version" text;--> statement-breakpoint
ALTER TABLE "federation_instances" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
ALTER TABLE "federation_instances" ADD COLUMN IF NOT EXISTS "last_error_at" bigint;--> statement-breakpoint
ALTER TABLE "federation_instances" ADD COLUMN IF NOT EXISTS "previous_public_key" text;--> statement-breakpoint
ALTER TABLE "federation_instances" ADD COLUMN IF NOT EXISTS "key_rotated_at" bigint;--> statement-breakpoint
ALTER TABLE "federation_keys" ADD COLUMN IF NOT EXISTS "retired_at" bigint;--> statement-breakpoint
ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "source" text;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'federation_outbox_instance_id_federation_instances_id_fk'
  ) THEN
    ALTER TABLE "federation_outbox" ADD CONSTRAINT "federation_outbox_instance_id_federation_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."federation_instances"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federation_outbox_due_idx" ON "federation_outbox" USING btree ("dead_at","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federation_outbox_instance_idx" ON "federation_outbox" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "federation_seen_jti_expires_idx" ON "federation_seen_jti" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_channels_pair_key_idx" ON "dm_channels" USING btree ("pair_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "dm_messages_federation_relay_id_idx" ON "dm_messages" USING btree ("federation_relay_id");--> statement-breakpoint
-- A database that suffered the shadow-identity confusion this batch fixes
-- may hold two shadows for one (instance, publicId). The unique index
-- cannot be built over them; leave it off with a warning so boot does not
-- fail, and let the operator merge the rows (the application tolerates the
-- missing index — it only loses the race protection).
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "users"
    WHERE "federated_instance_id" IS NOT NULL AND "federated_public_id" IS NOT NULL
    GROUP BY "federated_instance_id", "federated_public_id"
    HAVING count(*) > 1
  ) THEN
    RAISE WARNING 'users_federated_public_identity_idx skipped: duplicate (federated_instance_id, federated_public_id) rows exist — merge them, then run: CREATE UNIQUE INDEX users_federated_public_identity_idx ON users (federated_instance_id, federated_public_id)';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS "users_federated_public_identity_idx" ON "users" USING btree ("federated_instance_id","federated_public_id");
  END IF;
END $$;--> statement-breakpoint
-- dm_channels.pair_key backfill. Every existing 1:1 channel gets the key
-- the application now creates and looks channels up by (the two members'
-- identities sorted and joined with '|'; COLLATE "C" matches the code-unit
-- sort in pairKeyFor). Pairs that were minted twice by racing first
-- messages collapse into their lowest id: messages, read states and
-- sender keys move to the keeper, the duplicates' member rows cascade
-- away with them. Only NULL-keyed channels are considered, so a replay
-- finds nothing to do.
DO $$ BEGIN
  CREATE TEMP TABLE dm_pair_backfill ON COMMIT DROP AS
    SELECT channel_id, string_agg(identity, '|' ORDER BY identity COLLATE "C") AS pair_key
    FROM (
      SELECT m."dm_channel_id" AS channel_id,
             CASE
               WHEN u."is_federated" AND u."federated_public_id" IS NOT NULL AND fi."domain" IS NOT NULL
                 THEN 'federated:' || fi."domain" || ':' || u."federated_public_id"
               ELSE 'local:' || u."public_id"
             END AS identity
      FROM "dm_channel_members" m
      JOIN "dm_channels" c ON c."id" = m."dm_channel_id"
      JOIN "users" u ON u."id" = m."user_id"
      LEFT JOIN "federation_instances" fi ON fi."id" = u."federated_instance_id"
      WHERE c."is_group" = false AND c."pair_key" IS NULL
    ) ids
    GROUP BY channel_id
    HAVING count(*) = 2;

  -- A channel already carrying one of these keys (stamped lazily by the
  -- application before this ran) takes part in the keeper election too.
  CREATE TEMP TABLE dm_pair_keeper ON COMMIT DROP AS
    SELECT pair_key, min(channel_id) AS keeper_id
    FROM (
      SELECT pair_key, channel_id FROM dm_pair_backfill
      UNION
      SELECT c."pair_key", c."id" FROM "dm_channels" c
      WHERE c."pair_key" IN (SELECT pair_key FROM dm_pair_backfill)
    ) candidates
    GROUP BY pair_key;

  CREATE TEMP TABLE dm_pair_dupe ON COMMIT DROP AS
    SELECT b.channel_id AS dupe_id, k.keeper_id
    FROM dm_pair_backfill b
    JOIN dm_pair_keeper k ON k.pair_key = b.pair_key
    WHERE b.channel_id <> k.keeper_id;

  UPDATE "dm_messages" msg SET "dm_channel_id" = d.keeper_id
    FROM dm_pair_dupe d WHERE msg."dm_channel_id" = d.dupe_id;

  INSERT INTO "dm_read_states" ("user_id", "dm_channel_id", "last_read_message_id", "last_read_at")
    SELECT rs."user_id", d.keeper_id, max(rs."last_read_message_id"), max(rs."last_read_at")
    FROM "dm_read_states" rs
    JOIN dm_pair_dupe d ON d.dupe_id = rs."dm_channel_id"
    GROUP BY rs."user_id", d.keeper_id
  ON CONFLICT ("user_id", "dm_channel_id") DO UPDATE SET
    "last_read_message_id" = GREATEST("dm_read_states"."last_read_message_id", EXCLUDED."last_read_message_id"),
    "last_read_at" = GREATEST("dm_read_states"."last_read_at", EXCLUDED."last_read_at");

  UPDATE "dm_e2ee_sender_keys" sk SET "dm_channel_id" = d.keeper_id
    FROM dm_pair_dupe d
    WHERE sk."dm_channel_id" = d.dupe_id
      AND NOT EXISTS (
        SELECT 1 FROM "dm_e2ee_sender_keys" k
        WHERE k."dm_channel_id" = d.keeper_id
          AND k."from_user_id" = sk."from_user_id"
          AND k."to_user_id" = sk."to_user_id"
          AND k."sender_key_id" = sk."sender_key_id"
      );

  DELETE FROM "dm_channels" c USING dm_pair_dupe d WHERE c."id" = d.dupe_id;

  UPDATE "dm_channels" c SET "pair_key" = k.pair_key
    FROM dm_pair_keeper k WHERE c."id" = k.keeper_id AND c."pair_key" IS NULL;

  DROP TABLE dm_pair_dupe;
  DROP TABLE dm_pair_keeper;
  DROP TABLE dm_pair_backfill;
END $$;
