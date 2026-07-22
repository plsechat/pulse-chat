-- Abuse reports, layered: channel-message reports route to the server's
-- moderators (audience='server'); DM/account reports and escalations go
-- to the instance operator ('instance'), who also sees server-audience
-- rows as receipts. content_snapshot is server-verified for plaintext,
-- reporter-attested decrypted plaintext for E2EE (snapshot_attested).
-- Message FKs are SET NULL so a report outlives its target.
--
-- Idempotent by project convention (enforced by
-- scripts/check-migrations-idempotent.ts): migrations must survive a
-- replay after an emptied drizzle.__drizzle_migrations tracking table.
-- CREATE TABLE / CREATE INDEX use IF NOT EXISTS and the FK constraints
-- swallow duplicate_object.
CREATE TABLE IF NOT EXISTS "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target_user_id" integer NOT NULL,
	"target_message_id" integer,
	"target_dm_message_id" integer,
	"server_id" integer,
	"reporter_id" integer NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"content_snapshot" text,
	"snapshot_attested" boolean DEFAULT false NOT NULL,
	"audience" text NOT NULL,
	"escalation_reason" text,
	"escalated_at" bigint,
	"escalated_by" integer,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" integer,
	"resolved_at" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_target_user_id_users_id_fk"
    FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_target_message_id_messages_id_fk"
    FOREIGN KEY ("target_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_target_dm_message_id_dm_messages_id_fk"
    FOREIGN KEY ("target_dm_message_id") REFERENCES "public"."dm_messages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_server_id_servers_id_fk"
    FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_users_id_fk"
    FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_escalated_by_users_id_fk"
    FOREIGN KEY ("escalated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "reports" ADD CONSTRAINT "reports_resolved_by_users_id_fk"
    FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_audience_status_idx" ON "reports" USING btree ("audience","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_server_idx" ON "reports" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_target_user_idx" ON "reports" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_reporter_idx" ON "reports" USING btree ("reporter_id");
