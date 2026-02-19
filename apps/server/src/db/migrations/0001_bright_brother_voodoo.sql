CREATE TABLE "user_key_backups" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"encrypted_data" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_key_backups" ADD CONSTRAINT "user_key_backups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;