DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'encrypted_content') THEN
    UPDATE "messages" SET "content" = "encrypted_content" WHERE "e2ee" = true AND "encrypted_content" IS NOT NULL;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'dm_messages' AND column_name = 'encrypted_content') THEN
    UPDATE "dm_messages" SET "content" = "encrypted_content" WHERE "e2ee" = true AND "encrypted_content" IS NOT NULL;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "dm_messages" DROP COLUMN IF EXISTS "encrypted_content";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "encrypted_content";