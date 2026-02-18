CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"details" jsonb,
	"ip" text,
	"server_id" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automod_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"server_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb NOT NULL,
	"actions" jsonb NOT NULL,
	"exempt_role_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exempt_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"server_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "channel_notification_settings" (
	"user_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"level" text DEFAULT 'default' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "channel_notification_settings_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "channel_read_states" (
	"user_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"last_read_message_id" integer,
	"last_read_at" bigint NOT NULL,
	CONSTRAINT "channel_read_states_user_id_channel_id_pk" PRIMARY KEY("user_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "channel_role_permissions" (
	"channel_id" integer NOT NULL,
	"role_id" integer NOT NULL,
	"permission" text NOT NULL,
	"allow" boolean NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "channel_role_permissions_channel_id_role_id_permission_pk" PRIMARY KEY("channel_id","role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "channel_user_permissions" (
	"channel_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"permission" text NOT NULL,
	"allow" boolean NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "channel_user_permissions_channel_id_user_id_permission_pk" PRIMARY KEY("channel_id","user_id","permission")
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"topic" text,
	"file_access_token" text NOT NULL,
	"file_access_token_updated_at" bigint NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"category_id" integer,
	"server_id" integer NOT NULL,
	"slow_mode" integer DEFAULT 0 NOT NULL,
	"parent_channel_id" integer,
	"archived" boolean DEFAULT false NOT NULL,
	"auto_archive_duration" integer DEFAULT 1440,
	"forum_default_sort" text DEFAULT 'latest',
	"e2ee" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "channels_file_access_token_unique" UNIQUE("file_access_token")
);
--> statement-breakpoint
CREATE TABLE "dm_channel_members" (
	"dm_channel_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "dm_channel_members_dm_channel_id_user_id_pk" PRIMARY KEY("dm_channel_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "dm_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text,
	"owner_id" integer,
	"icon_file_id" integer,
	"is_group" boolean DEFAULT false NOT NULL,
	"e2ee" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "dm_message_files" (
	"dm_message_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "dm_message_files_dm_message_id_file_id_pk" PRIMARY KEY("dm_message_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "dm_message_reactions" (
	"dm_message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" text NOT NULL,
	"file_id" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "dm_message_reactions_dm_message_id_user_id_emoji_pk" PRIMARY KEY("dm_message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "dm_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text,
	"encrypted_content" text,
	"e2ee" boolean DEFAULT false NOT NULL,
	"user_id" integer NOT NULL,
	"dm_channel_id" integer NOT NULL,
	"metadata" jsonb,
	"reply_to_id" integer,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" bigint,
	"pinned_by" integer,
	"edited" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "dm_read_states" (
	"user_id" integer NOT NULL,
	"dm_channel_id" integer NOT NULL,
	"last_read_message_id" integer,
	"last_read_at" bigint NOT NULL,
	CONSTRAINT "dm_read_states_user_id_dm_channel_id_pk" PRIMARY KEY("user_id","dm_channel_id")
);
--> statement-breakpoint
CREATE TABLE "e2ee_sender_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"from_user_id" integer NOT NULL,
	"to_user_id" integer NOT NULL,
	"distribution_message" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "emojis" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"file_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"server_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "emojis_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "federation_instances" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"name" text,
	"public_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"direction" text NOT NULL,
	"added_by" integer,
	"last_seen_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "federation_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"original_name" text NOT NULL,
	"md5" text NOT NULL,
	"user_id" integer NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"extension" text NOT NULL,
	"encrypted" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "files_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "forum_post_tags" (
	"thread_id" integer NOT NULL,
	"tag_id" integer NOT NULL,
	CONSTRAINT "forum_post_tags_thread_id_tag_id_pk" PRIMARY KEY("thread_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "forum_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel_id" integer NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#808080' NOT NULL,
	"emoji_id" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "friend_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"sender_id" integer NOT NULL,
	"receiver_id" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "friendships" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"friend_id" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"creator_id" integer NOT NULL,
	"server_id" integer NOT NULL,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "invites_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "logins" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"user_agent" text,
	"os" text,
	"device" text,
	"ip" text,
	"hostname" text,
	"city" text,
	"region" text,
	"country" text,
	"loc" text,
	"org" text,
	"postal" text,
	"timezone" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "message_files" (
	"message_id" integer NOT NULL,
	"file_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "message_files_message_id_file_id_pk" PRIMARY KEY("message_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "message_reactions" (
	"message_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"emoji" text NOT NULL,
	"file_id" integer,
	"created_at" bigint NOT NULL,
	CONSTRAINT "message_reactions_message_id_user_id_emoji_pk" PRIMARY KEY("message_id","user_id","emoji")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"content" text,
	"encrypted_content" text,
	"e2ee" boolean DEFAULT false NOT NULL,
	"user_id" integer NOT NULL,
	"channel_id" integer NOT NULL,
	"editable" boolean DEFAULT true,
	"metadata" jsonb,
	"reply_to_id" integer,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinned_at" bigint,
	"pinned_by" integer,
	"thread_id" integer,
	"webhook_id" integer,
	"edited" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "plugin_data" (
	"plugin_id" text NOT NULL,
	"server_id" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "plugin_data_plugin_id_server_id_pk" PRIMARY KEY("plugin_id","server_id")
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" integer NOT NULL,
	"permission" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "role_permissions_role_id_permission_pk" PRIMARY KEY("role_id","permission")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#ffffff' NOT NULL,
	"is_persistent" boolean NOT NULL,
	"is_default" boolean NOT NULL,
	"server_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "server_members" (
	"server_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"joined_at" bigint NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"notification_level" text DEFAULT 'default' NOT NULL,
	CONSTRAINT "server_members_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"password" text,
	"public_id" text NOT NULL,
	"secret_token" text,
	"logo_id" integer,
	"owner_id" integer,
	"allow_new_users" boolean NOT NULL,
	"storage_uploads_enabled" boolean NOT NULL,
	"storage_quota" bigint NOT NULL,
	"storage_upload_max_file_size" bigint NOT NULL,
	"storage_space_quota_by_user" bigint NOT NULL,
	"storage_overflow_action" text NOT NULL,
	"enable_plugins" boolean NOT NULL,
	"discoverable" boolean DEFAULT false NOT NULL,
	"federatable" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "servers_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"name" text NOT NULL,
	"description" text,
	"password" text,
	"server_id" text NOT NULL,
	"secret_token" text,
	"logo_id" integer,
	"allow_new_users" boolean NOT NULL,
	"storage_uploads_enabled" boolean NOT NULL,
	"storage_quota" bigint NOT NULL,
	"storage_upload_max_file_size" bigint NOT NULL,
	"storage_space_quota_by_user" bigint NOT NULL,
	"storage_overflow_action" text NOT NULL,
	"enable_plugins" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identity_keys" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"identity_public_key" text NOT NULL,
	"registration_id" integer NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"target_user_id" integer NOT NULL,
	"content" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "user_one_time_pre_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" integer NOT NULL,
	"role_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "user_signed_pre_keys" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"key_id" integer NOT NULL,
	"public_key" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"supabase_id" text NOT NULL,
	"name" text NOT NULL,
	"avatar_id" integer,
	"banner_id" integer,
	"bio" text,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"banned_at" bigint,
	"banner_color" text,
	"last_login_at" bigint NOT NULL,
	"is_federated" boolean DEFAULT false NOT NULL,
	"federated_instance_id" integer,
	"federated_username" text,
	"public_id" text,
	"federated_public_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "users_supabase_id_unique" UNIQUE("supabase_id"),
	CONSTRAINT "users_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"channel_id" integer NOT NULL,
	"token" text NOT NULL,
	"avatar_file_id" integer,
	"created_by" integer NOT NULL,
	"server_id" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	CONSTRAINT "webhooks_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automod_rules" ADD CONSTRAINT "automod_rules_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automod_rules" ADD CONSTRAINT "automod_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_notification_settings" ADD CONSTRAINT "channel_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_notification_settings" ADD CONSTRAINT "channel_notification_settings_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_read_states" ADD CONSTRAINT "channel_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_read_states" ADD CONSTRAINT "channel_read_states_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_read_states" ADD CONSTRAINT "channel_read_states_last_read_message_id_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_role_permissions" ADD CONSTRAINT "channel_role_permissions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_role_permissions" ADD CONSTRAINT "channel_role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_user_permissions" ADD CONSTRAINT "channel_user_permissions_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_user_permissions" ADD CONSTRAINT "channel_user_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_channel_members" ADD CONSTRAINT "dm_channel_members_dm_channel_id_dm_channels_id_fk" FOREIGN KEY ("dm_channel_id") REFERENCES "public"."dm_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_channel_members" ADD CONSTRAINT "dm_channel_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_channels" ADD CONSTRAINT "dm_channels_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_channels" ADD CONSTRAINT "dm_channels_icon_file_id_files_id_fk" FOREIGN KEY ("icon_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message_files" ADD CONSTRAINT "dm_message_files_dm_message_id_dm_messages_id_fk" FOREIGN KEY ("dm_message_id") REFERENCES "public"."dm_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message_files" ADD CONSTRAINT "dm_message_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message_reactions" ADD CONSTRAINT "dm_message_reactions_dm_message_id_dm_messages_id_fk" FOREIGN KEY ("dm_message_id") REFERENCES "public"."dm_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message_reactions" ADD CONSTRAINT "dm_message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_message_reactions" ADD CONSTRAINT "dm_message_reactions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_dm_channel_id_dm_channels_id_fk" FOREIGN KEY ("dm_channel_id") REFERENCES "public"."dm_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_read_states" ADD CONSTRAINT "dm_read_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_read_states" ADD CONSTRAINT "dm_read_states_dm_channel_id_dm_channels_id_fk" FOREIGN KEY ("dm_channel_id") REFERENCES "public"."dm_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_read_states" ADD CONSTRAINT "dm_read_states_last_read_message_id_dm_messages_id_fk" FOREIGN KEY ("last_read_message_id") REFERENCES "public"."dm_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_sender_keys" ADD CONSTRAINT "e2ee_sender_keys_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_sender_keys" ADD CONSTRAINT "e2ee_sender_keys_from_user_id_users_id_fk" FOREIGN KEY ("from_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "e2ee_sender_keys" ADD CONSTRAINT "e2ee_sender_keys_to_user_id_users_id_fk" FOREIGN KEY ("to_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emojis" ADD CONSTRAINT "emojis_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emojis" ADD CONSTRAINT "emojis_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emojis" ADD CONSTRAINT "emojis_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "federation_instances" ADD CONSTRAINT "federation_instances_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_post_tags" ADD CONSTRAINT "forum_post_tags_thread_id_channels_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_post_tags" ADD CONSTRAINT "forum_post_tags_tag_id_forum_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."forum_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_tags" ADD CONSTRAINT "forum_tags_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forum_tags" ADD CONSTRAINT "forum_tags_emoji_id_emojis_id_fk" FOREIGN KEY ("emoji_id") REFERENCES "public"."emojis"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friend_requests" ADD CONSTRAINT "friend_requests_receiver_id_users_id_fk" FOREIGN KEY ("receiver_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendships" ADD CONSTRAINT "friendships_friend_id_users_id_fk" FOREIGN KEY ("friend_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_creator_id_users_id_fk" FOREIGN KEY ("creator_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "logins" ADD CONSTRAINT "logins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_files" ADD CONSTRAINT "message_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_pinned_by_users_id_fk" FOREIGN KEY ("pinned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_channels_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_data" ADD CONSTRAINT "plugin_data_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_members" ADD CONSTRAINT "server_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_logo_id_files_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_logo_id_files_id_fk" FOREIGN KEY ("logo_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identity_keys" ADD CONSTRAINT "user_identity_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_notes" ADD CONSTRAINT "user_notes_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_one_time_pre_keys" ADD CONSTRAINT "user_one_time_pre_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_signed_pre_keys" ADD CONSTRAINT "user_signed_pre_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_id_files_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_banner_id_files_id_fk" FOREIGN KEY ("banner_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_channel_id_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_avatar_file_id_files_id_fk" FOREIGN KEY ("avatar_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_log_user_idx" ON "activity_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_log_type_idx" ON "activity_log" USING btree ("type");--> statement-breakpoint
CREATE INDEX "activity_log_created_idx" ON "activity_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_log_user_created_idx" ON "activity_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_type_created_idx" ON "activity_log" USING btree ("type","created_at");--> statement-breakpoint
CREATE INDEX "activity_log_server_idx" ON "activity_log" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "automod_rules_server_idx" ON "automod_rules" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "automod_rules_type_idx" ON "automod_rules" USING btree ("type");--> statement-breakpoint
CREATE INDEX "automod_rules_enabled_idx" ON "automod_rules" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "categories_position_idx" ON "categories" USING btree ("position");--> statement-breakpoint
CREATE INDEX "categories_server_idx" ON "categories" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "channel_notif_user_idx" ON "channel_notification_settings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channel_notif_channel_idx" ON "channel_notification_settings" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "channel_read_states_user_idx" ON "channel_read_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channel_read_states_channel_idx" ON "channel_read_states" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "channel_read_states_last_read_idx" ON "channel_read_states" USING btree ("last_read_message_id");--> statement-breakpoint
CREATE INDEX "channel_role_permissions_channel_idx" ON "channel_role_permissions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "channel_role_permissions_role_idx" ON "channel_role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "channel_role_permissions_channel_perm_idx" ON "channel_role_permissions" USING btree ("channel_id","permission");--> statement-breakpoint
CREATE INDEX "channel_role_permissions_role_perm_idx" ON "channel_role_permissions" USING btree ("role_id","permission");--> statement-breakpoint
CREATE INDEX "channel_role_permissions_allow_idx" ON "channel_role_permissions" USING btree ("allow");--> statement-breakpoint
CREATE INDEX "channel_user_permissions_channel_idx" ON "channel_user_permissions" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "channel_user_permissions_user_idx" ON "channel_user_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "channel_user_permissions_channel_perm_idx" ON "channel_user_permissions" USING btree ("channel_id","permission");--> statement-breakpoint
CREATE INDEX "channel_user_permissions_user_perm_idx" ON "channel_user_permissions" USING btree ("user_id","permission");--> statement-breakpoint
CREATE INDEX "channel_user_permissions_allow_idx" ON "channel_user_permissions" USING btree ("allow");--> statement-breakpoint
CREATE INDEX "channels_category_idx" ON "channels" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "channels_position_idx" ON "channels" USING btree ("position");--> statement-breakpoint
CREATE INDEX "channels_type_idx" ON "channels" USING btree ("type");--> statement-breakpoint
CREATE INDEX "channels_category_position_idx" ON "channels" USING btree ("category_id","position");--> statement-breakpoint
CREATE INDEX "channels_server_idx" ON "channels" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "channels_parent_idx" ON "channels" USING btree ("parent_channel_id");--> statement-breakpoint
CREATE INDEX "dm_channel_members_channel_idx" ON "dm_channel_members" USING btree ("dm_channel_id");--> statement-breakpoint
CREATE INDEX "dm_channel_members_user_idx" ON "dm_channel_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dm_message_files_msg_idx" ON "dm_message_files" USING btree ("dm_message_id");--> statement-breakpoint
CREATE INDEX "dm_message_files_file_idx" ON "dm_message_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "dm_reaction_msg_idx" ON "dm_message_reactions" USING btree ("dm_message_id");--> statement-breakpoint
CREATE INDEX "dm_reaction_emoji_idx" ON "dm_message_reactions" USING btree ("emoji");--> statement-breakpoint
CREATE INDEX "dm_reaction_user_idx" ON "dm_message_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dm_messages_user_idx" ON "dm_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dm_messages_channel_idx" ON "dm_messages" USING btree ("dm_channel_id");--> statement-breakpoint
CREATE INDEX "dm_messages_created_idx" ON "dm_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "dm_messages_channel_created_idx" ON "dm_messages" USING btree ("dm_channel_id","created_at");--> statement-breakpoint
CREATE INDEX "dm_messages_pinned_idx" ON "dm_messages" USING btree ("pinned");--> statement-breakpoint
CREATE INDEX "dm_messages_channel_pinned_idx" ON "dm_messages" USING btree ("dm_channel_id","pinned");--> statement-breakpoint
CREATE INDEX "dm_read_states_user_idx" ON "dm_read_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "dm_read_states_channel_idx" ON "dm_read_states" USING btree ("dm_channel_id");--> statement-breakpoint
CREATE INDEX "e2ee_sender_keys_channel_idx" ON "e2ee_sender_keys" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "e2ee_sender_keys_from_idx" ON "e2ee_sender_keys" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "e2ee_sender_keys_to_idx" ON "e2ee_sender_keys" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "e2ee_sender_keys_channel_to_idx" ON "e2ee_sender_keys" USING btree ("channel_id","to_user_id");--> statement-breakpoint
CREATE INDEX "emojis_user_idx" ON "emojis" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "emojis_file_idx" ON "emojis" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "emojis_name_idx" ON "emojis" USING btree ("name");--> statement-breakpoint
CREATE INDEX "emojis_server_idx" ON "emojis" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "federation_instances_domain_idx" ON "federation_instances" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "federation_instances_status_idx" ON "federation_instances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "files_user_idx" ON "files" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "files_md5_idx" ON "files" USING btree ("md5");--> statement-breakpoint
CREATE INDEX "files_created_idx" ON "files" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "files_name_idx" ON "files" USING btree ("name");--> statement-breakpoint
CREATE INDEX "forum_tags_channel_idx" ON "forum_tags" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "friend_requests_sender_idx" ON "friend_requests" USING btree ("sender_id");--> statement-breakpoint
CREATE INDEX "friend_requests_receiver_idx" ON "friend_requests" USING btree ("receiver_id");--> statement-breakpoint
CREATE INDEX "friend_requests_status_idx" ON "friend_requests" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "friend_requests_pair_idx" ON "friend_requests" USING btree ("sender_id","receiver_id");--> statement-breakpoint
CREATE INDEX "friendships_user_idx" ON "friendships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "friendships_friend_idx" ON "friendships" USING btree ("friend_id");--> statement-breakpoint
CREATE UNIQUE INDEX "friendships_pair_idx" ON "friendships" USING btree ("user_id","friend_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_code_idx" ON "invites" USING btree ("code");--> statement-breakpoint
CREATE INDEX "invites_creator_idx" ON "invites" USING btree ("creator_id");--> statement-breakpoint
CREATE INDEX "invites_server_idx" ON "invites" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "invites_expires_idx" ON "invites" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "invites_uses_idx" ON "invites" USING btree ("uses");--> statement-breakpoint
CREATE INDEX "logins_user_idx" ON "logins" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "logins_ip_idx" ON "logins" USING btree ("ip");--> statement-breakpoint
CREATE INDEX "logins_created_idx" ON "logins" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "logins_user_created_idx" ON "logins" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "message_files_msg_idx" ON "message_files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "message_files_file_idx" ON "message_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "reaction_msg_idx" ON "message_reactions" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "reaction_emoji_idx" ON "message_reactions" USING btree ("emoji");--> statement-breakpoint
CREATE INDEX "reaction_user_idx" ON "message_reactions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "reaction_msg_emoji_idx" ON "message_reactions" USING btree ("message_id","emoji");--> statement-breakpoint
CREATE INDEX "messages_user_idx" ON "messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "messages_channel_idx" ON "messages" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "messages_created_idx" ON "messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "messages_channel_created_idx" ON "messages" USING btree ("channel_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_pinned_idx" ON "messages" USING btree ("pinned");--> statement-breakpoint
CREATE INDEX "messages_channel_pinned_idx" ON "messages" USING btree ("channel_id","pinned");--> statement-breakpoint
CREATE INDEX "messages_thread_idx" ON "messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "messages_webhook_idx" ON "messages" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "plugin_data_server_idx" ON "plugin_data" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "role_permissions_role_idx" ON "role_permissions" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "role_permissions_permission_idx" ON "role_permissions" USING btree ("permission");--> statement-breakpoint
CREATE INDEX "roles_is_default_idx" ON "roles" USING btree ("is_default");--> statement-breakpoint
CREATE INDEX "roles_is_persistent_idx" ON "roles" USING btree ("is_persistent");--> statement-breakpoint
CREATE INDEX "roles_server_idx" ON "roles" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_members_server_idx" ON "server_members" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "server_members_user_idx" ON "server_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "servers_public_id_idx" ON "servers" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "servers_owner_idx" ON "servers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "servers_name_idx" ON "servers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "servers_discoverable_idx" ON "servers" USING btree ("discoverable");--> statement-breakpoint
CREATE INDEX "servers_federatable_idx" ON "servers" USING btree ("federatable");--> statement-breakpoint
CREATE INDEX "settings_server_idx" ON "settings" USING btree ("server_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_server_unique_idx" ON "settings" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "user_notes_author_idx" ON "user_notes" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "user_notes_target_idx" ON "user_notes" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "user_notes_author_target_idx" ON "user_notes" USING btree ("author_id","target_user_id");--> statement-breakpoint
CREATE INDEX "user_otp_keys_user_idx" ON "user_one_time_pre_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_otp_keys_user_key_idx" ON "user_one_time_pre_keys" USING btree ("user_id","key_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE INDEX "user_signed_pre_keys_user_idx" ON "user_signed_pre_keys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_signed_pre_keys_user_key_idx" ON "user_signed_pre_keys" USING btree ("user_id","key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_supabase_id_idx" ON "users" USING btree ("supabase_id");--> statement-breakpoint
CREATE INDEX "users_name_idx" ON "users" USING btree ("name");--> statement-breakpoint
CREATE INDEX "users_banned_idx" ON "users" USING btree ("banned");--> statement-breakpoint
CREATE INDEX "users_last_login_idx" ON "users" USING btree ("last_login_at");--> statement-breakpoint
CREATE INDEX "users_federated_idx" ON "users" USING btree ("is_federated");--> statement-breakpoint
CREATE INDEX "users_federated_instance_idx" ON "users" USING btree ("federated_instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_federated_identity_idx" ON "users" USING btree ("federated_instance_id","federated_username");--> statement-breakpoint
CREATE UNIQUE INDEX "users_public_id_idx" ON "users" USING btree ("public_id");--> statement-breakpoint
CREATE INDEX "users_federated_public_id_idx" ON "users" USING btree ("federated_public_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhooks_token_idx" ON "webhooks" USING btree ("token");--> statement-breakpoint
CREATE INDEX "webhooks_channel_idx" ON "webhooks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "webhooks_server_idx" ON "webhooks" USING btree ("server_id");