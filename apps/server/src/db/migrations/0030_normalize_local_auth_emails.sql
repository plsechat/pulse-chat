-- Local-auth e-mails are matched case-insensitively from now on (the
-- backend lower-cases on createUser and signInWithPassword). Bring the
-- stored rows in line so a user who signed up as Foo@X.com can sign in.
--
-- A row is left untouched when lowering it would collide with another
-- account that already owns lower(email) — an already-canonical row, or
-- an earlier-created (lower id; ids are UUIDv7, time-ordered) one. Those
-- accounts are never deleted; they are reported below so the operator
-- can merge them by hand. Sign-in prefers the exact-case row and falls
-- back to the oldest match, so the surviving account keeps working.
--
-- Idempotent by construction: the second run matches nothing (CI applies
-- every migration twice — see scripts/check-migrations-idempotent.ts).
UPDATE "local_auth_users" u
SET "email" = lower(u."email")
WHERE u."email" <> lower(u."email")
  AND NOT EXISTS (
    SELECT 1 FROM "local_auth_users" o
    WHERE o."id" <> u."id"
      AND lower(o."email") = lower(u."email")
      AND (o."email" = lower(o."email") OR o."id" < u."id")
  );--> statement-breakpoint
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT "id", "email" FROM "local_auth_users" WHERE "email" <> lower("email")
  LOOP
    RAISE WARNING 'local_auth_users: % (id %) not lower-cased — another account already owns %; merge by hand',
      r."email", r."id", lower(r."email");
  END LOOP;
END $$;
