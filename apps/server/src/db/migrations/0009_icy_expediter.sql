CREATE TABLE "thread_followers" (
	"thread_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "thread_followers_thread_id_user_id_pk" PRIMARY KEY("thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "thread_followers" ADD CONSTRAINT "thread_followers_thread_id_channels_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_followers" ADD CONSTRAINT "thread_followers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "thread_followers_thread_idx" ON "thread_followers" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "thread_followers_user_idx" ON "thread_followers" USING btree ("user_id");