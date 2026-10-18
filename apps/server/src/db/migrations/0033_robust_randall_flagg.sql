-- System activity events (SERVER_STARTED, ...) have no human actor. The
-- column used to be NOT NULL with a hard-coded actor id of 1, which
-- violates the users FK on a fresh database and silently dropped every
-- queued activity row behind it. NULL now means "system". DROP NOT NULL
-- is a no-op when the column is already nullable, so a second run is safe.
ALTER TABLE "activity_log" ALTER COLUMN "user_id" DROP NOT NULL;
