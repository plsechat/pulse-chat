-- Per-community Planner switch: servers.enable_events (default on). Off
-- hides the planner and refuses its routes/feed/reminders; existing
-- events are kept and return when it is switched on again.
-- Replay-safe: CI applies each migration twice.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "enable_events" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Owner roles are created with every permission that existed at the time
-- and can never be edited afterwards (routers/roles/update-role.ts), so a
-- permission added later (MANAGE_EVENTS, MANAGE_ANNOUNCEMENTS,
-- USE_SOUNDBOARD, MANAGE_SOUNDS since 0.3.0) was missing on every
-- community created before it — the owner saw no Events tab and no
-- "New event". Give each owner role (the bootstrap row id 1, or
-- persistent + non-default, same rule as update-role.ts) whatever it is
-- missing from the full set as of this migration. ON CONFLICT keeps it
-- replay-safe.
INSERT INTO "role_permissions" ("role_id", "permission", "created_at", "updated_at")
SELECT r."id", p."permission",
       (extract(epoch from now()) * 1000)::bigint,
       (extract(epoch from now()) * 1000)::bigint
FROM "roles" r
CROSS JOIN (VALUES
  ('SEND_MESSAGES'), ('REACT_TO_MESSAGES'), ('UPLOAD_FILES'),
  ('JOIN_VOICE_CHANNELS'), ('SHARE_SCREEN'), ('ENABLE_WEBCAM'),
  ('MANAGE_CHANNELS'), ('MANAGE_CHANNEL_PERMISSIONS'), ('MANAGE_CATEGORIES'),
  ('MANAGE_ROLES'), ('MANAGE_EMOJIS'), ('MANAGE_SETTINGS'), ('MANAGE_USERS'),
  ('MANAGE_MESSAGES'), ('MANAGE_INVITES'), ('MANAGE_PLUGINS'),
  ('EXECUTE_PLUGIN_COMMANDS'), ('PIN_MESSAGES'), ('MANAGE_WEBHOOKS'),
  ('MANAGE_AUTOMOD'), ('VIEW_REPORTS'), ('MANAGE_EVENTS'),
  ('MANAGE_ANNOUNCEMENTS'), ('USE_SOUNDBOARD'), ('MANAGE_SOUNDS')
) AS p("permission")
WHERE r."id" = 1 OR (r."is_persistent" AND NOT r."is_default")
ON CONFLICT ("role_id", "permission") DO NOTHING;
