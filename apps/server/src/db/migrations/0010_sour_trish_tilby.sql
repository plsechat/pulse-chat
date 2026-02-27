UPDATE "messages" SET "content" = "encrypted_content" WHERE "e2ee" = true AND "encrypted_content" IS NOT NULL;--> statement-breakpoint
UPDATE "dm_messages" SET "content" = "encrypted_content" WHERE "e2ee" = true AND "encrypted_content" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "dm_messages" DROP COLUMN "encrypted_content";--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN "encrypted_content";