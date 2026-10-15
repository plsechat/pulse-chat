-- The updates feature (auto-updater + Permission.MANAGE_UPDATES) was
-- removed. Strip any grants of the now-unknown permission so role rows
-- never carry a value the Permission enum no longer has.
--
-- Idempotent by construction: a plain DELETE on a predicate that matches
-- nothing after the first run (CI applies every migration twice — see
-- scripts/check-migrations-idempotent.ts).
DELETE FROM "role_permissions" WHERE "permission" = 'MANAGE_UPDATES';
