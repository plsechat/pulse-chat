-- Profile cosmetics: avatar decorations + styled display names.
-- users.avatar_decoration holds 'preset:<slug>' (client-bundled APNG
-- frames); users.name_style holds the TNameStyle jsonb shape.
-- Hand-patched to idempotent form per the replay-safety net (see
-- scripts/check-migrations-idempotent.ts).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "avatar_decoration" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "name_style" jsonb;
