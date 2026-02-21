CREATE TABLE "user_federated_servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"instance_id" integer NOT NULL,
	"remote_server_id" integer NOT NULL,
	"remote_server_public_id" text NOT NULL,
	"remote_server_name" text,
	"joined_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_federated_servers" ADD CONSTRAINT "user_federated_servers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_federated_servers" ADD CONSTRAINT "user_federated_servers_instance_id_federation_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."federation_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ufs_user_instance_server_idx" ON "user_federated_servers" USING btree ("user_id","instance_id","remote_server_id");--> statement-breakpoint
CREATE INDEX "ufs_user_idx" ON "user_federated_servers" USING btree ("user_id");