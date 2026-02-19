import {
  type TActivityLogDetailsMap,
  type TMessageMetadata
} from '@pulse/shared';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  uniqueIndex
} from 'drizzle-orm/pg-core';

const files = pgTable(
  'files',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    originalName: text('original_name').notNull(),
    md5: text('md5').notNull(),
    userId: integer('user_id').notNull(),
    size: integer('size').notNull(),
    mimeType: text('mime_type').notNull(),
    extension: text('extension').notNull(),
    encrypted: boolean('encrypted').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('files_user_idx').on(t.userId),
    index('files_md5_idx').on(t.md5),
    index('files_created_idx').on(t.createdAt),
    index('files_name_idx').on(t.name)
  ]
);

const settings = pgTable(
  'settings',
  {
    name: text('name').notNull(),
    description: text('description'),
    password: text('password'),
    serverId: text('server_id').notNull(),
    secretToken: text('secret_token'),
    logoId: integer('logo_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    allowNewUsers: boolean('allow_new_users').notNull(),
    storageUploadEnabled: boolean('storage_uploads_enabled').notNull(),
    storageQuota: bigint('storage_quota', { mode: 'number' }).notNull(),
    storageUploadMaxFileSize: bigint('storage_upload_max_file_size', {
      mode: 'number'
    }).notNull(),
    storageSpaceQuotaByUser: bigint('storage_space_quota_by_user', {
      mode: 'number'
    }).notNull(),
    storageOverflowAction: text('storage_overflow_action').notNull(),
    enablePlugins: boolean('enable_plugins').notNull()
  },
  (t) => [
    index('settings_server_idx').on(t.serverId),
    uniqueIndex('settings_server_unique_idx').on(t.serverId)
  ]
);

const servers = pgTable(
  'servers',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    password: text('password'),
    publicId: text('public_id').notNull().unique(),
    secretToken: text('secret_token'),
    logoId: integer('logo_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    ownerId: integer('owner_id').references(() => users.id, {
      onDelete: 'set null'
    }),
    allowNewUsers: boolean('allow_new_users').notNull(),
    storageUploadEnabled: boolean('storage_uploads_enabled').notNull(),
    storageQuota: bigint('storage_quota', { mode: 'number' }).notNull(),
    storageUploadMaxFileSize: bigint('storage_upload_max_file_size', {
      mode: 'number'
    }).notNull(),
    storageSpaceQuotaByUser: bigint('storage_space_quota_by_user', {
      mode: 'number'
    }).notNull(),
    storageOverflowAction: text('storage_overflow_action').notNull(),
    enablePlugins: boolean('enable_plugins').notNull(),
    discoverable: boolean('discoverable').notNull().default(false),
    federatable: boolean('federatable').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    uniqueIndex('servers_public_id_idx').on(t.publicId),
    index('servers_owner_idx').on(t.ownerId),
    index('servers_name_idx').on(t.name),
    index('servers_discoverable_idx').on(t.discoverable),
    index('servers_federatable_idx').on(t.federatable)
  ]
);

const serverMembers = pgTable(
  'server_members',
  {
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinedAt: bigint('joined_at', { mode: 'number' }).notNull(),
    muted: boolean('muted').notNull().default(false),
    notificationLevel: text('notification_level').notNull().default('default'),
    position: integer('position').notNull().default(0)
  },
  (t) => [
    primaryKey({ columns: [t.serverId, t.userId] }),
    index('server_members_server_idx').on(t.serverId),
    index('server_members_user_idx').on(t.userId)
  ]
);

const roles = pgTable(
  'roles',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color').notNull().default('#ffffff'),
    isPersistent: boolean('is_persistent').notNull(),
    isDefault: boolean('is_default').notNull(),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('roles_is_default_idx').on(t.isDefault),
    index('roles_is_persistent_idx').on(t.isPersistent),
    index('roles_server_idx').on(t.serverId)
  ]
);

const categories = pgTable(
  'categories',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('categories_position_idx').on(t.position),
    index('categories_server_idx').on(t.serverId)
  ]
);

const channels = pgTable(
  'channels',
  {
    id: serial('id').primaryKey(),
    type: text('type').notNull(),
    name: text('name').notNull(),
    topic: text('topic'),
    fileAccessToken: text('file_access_token').notNull().unique(),
    fileAccessTokenUpdatedAt: bigint('file_access_token_updated_at', {
      mode: 'number'
    }).notNull(),
    private: boolean('private').notNull().default(false),
    position: integer('position').notNull(),
    categoryId: integer('category_id').references(() => categories.id, {
      onDelete: 'cascade'
    }),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    slowMode: integer('slow_mode').notNull().default(0),
    parentChannelId: integer('parent_channel_id'),
    archived: boolean('archived').notNull().default(false),
    autoArchiveDuration: integer('auto_archive_duration').default(1440),
    forumDefaultSort: text('forum_default_sort').default('latest'),
    e2ee: boolean('e2ee').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('channels_category_idx').on(t.categoryId),
    index('channels_position_idx').on(t.position),
    index('channels_type_idx').on(t.type),
    index('channels_category_position_idx').on(t.categoryId, t.position),
    index('channels_server_idx').on(t.serverId),
    index('channels_parent_idx').on(t.parentChannelId)
  ]
);

const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    supabaseId: text('supabase_id').notNull().unique(),
    name: text('name').notNull(),
    avatarId: integer('avatar_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    bannerId: integer('banner_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    bio: text('bio'),
    banned: boolean('banned').notNull().default(false),
    banReason: text('ban_reason'),
    bannedAt: bigint('banned_at', { mode: 'number' }),
    bannerColor: text('banner_color'),
    lastLoginAt: bigint('last_login_at', { mode: 'number' })
      .notNull()
      .$defaultFn(() => Date.now()),
    isFederated: boolean('is_federated').notNull().default(false),
    federatedInstanceId: integer('federated_instance_id'),
    federatedUsername: text('federated_username'),
    publicId: text('public_id').unique(),
    federatedPublicId: text('federated_public_id'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    uniqueIndex('users_supabase_id_idx').on(t.supabaseId),
    index('users_name_idx').on(t.name),
    index('users_banned_idx').on(t.banned),
    index('users_last_login_idx').on(t.lastLoginAt),
    index('users_federated_idx').on(t.isFederated),
    index('users_federated_instance_idx').on(t.federatedInstanceId),
    uniqueIndex('users_federated_identity_idx').on(
      t.federatedInstanceId,
      t.federatedUsername
    ),
    uniqueIndex('users_public_id_idx').on(t.publicId),
    index('users_federated_public_id_idx').on(t.federatedPublicId)
  ]
);

const userRoles = pgTable(
  'user_roles',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.roleId] }),
    index('user_roles_user_idx').on(t.userId),
    index('user_roles_role_idx').on(t.roleId)
  ]
);

const logins = pgTable(
  'logins',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    userAgent: text('user_agent'),
    os: text('os'),
    device: text('device'),
    ip: text('ip'),
    hostname: text('hostname'),
    city: text('city'),
    region: text('region'),
    country: text('country'),
    loc: text('loc'),
    org: text('org'),
    postal: text('postal'),
    timezone: text('timezone'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('logins_user_idx').on(t.userId),
    index('logins_ip_idx').on(t.ip),
    index('logins_created_idx').on(t.createdAt),
    index('logins_user_created_idx').on(t.userId, t.createdAt)
  ]
);

const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),
    content: text('content'),
    encryptedContent: text('encrypted_content'),
    e2ee: boolean('e2ee').notNull().default(false),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    editable: boolean('editable').default(true),
    metadata: jsonb('metadata').$type<TMessageMetadata[]>(),
    replyToId: integer('reply_to_id'),
    pinned: boolean('pinned').notNull().default(false),
    pinnedAt: bigint('pinned_at', { mode: 'number' }),
    pinnedBy: integer('pinned_by').references(() => users.id, {
      onDelete: 'set null'
    }),
    threadId: integer('thread_id').references(() => channels.id, {
      onDelete: 'set null'
    }),
    webhookId: integer('webhook_id'),
    edited: boolean('edited').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('messages_user_idx').on(t.userId),
    index('messages_channel_idx').on(t.channelId),
    index('messages_created_idx').on(t.createdAt),
    index('messages_channel_created_idx').on(t.channelId, t.createdAt),
    index('messages_pinned_idx').on(t.pinned),
    index('messages_channel_pinned_idx').on(t.channelId, t.pinned),
    index('messages_thread_idx').on(t.threadId),
    index('messages_webhook_idx').on(t.webhookId)
  ]
);

const messageFiles = pgTable(
  'message_files',
  {
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.fileId] }),
    index('message_files_msg_idx').on(t.messageId),
    index('message_files_file_idx').on(t.fileId)
  ]
);

const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    primaryKey({ columns: [t.roleId, t.permission] }),
    index('role_permissions_role_idx').on(t.roleId),
    index('role_permissions_permission_idx').on(t.permission)
  ]
);

const emojis = pgTable(
  'emojis',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull().unique(),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('emojis_user_idx').on(t.userId),
    index('emojis_file_idx').on(t.fileId),
    uniqueIndex('emojis_name_idx').on(t.name),
    index('emojis_server_idx').on(t.serverId)
  ]
);

const messageReactions = pgTable(
  'message_reactions',
  {
    messageId: integer('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    fileId: integer('file_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index('reaction_msg_idx').on(t.messageId),
    index('reaction_emoji_idx').on(t.emoji),
    index('reaction_user_idx').on(t.userId),
    index('reaction_msg_emoji_idx').on(t.messageId, t.emoji)
  ]
);

const invites = pgTable(
  'invites',
  {
    id: serial('id').primaryKey(),
    code: text('code').notNull().unique(),
    creatorId: integer('creator_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    expiresAt: bigint('expires_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    uniqueIndex('invites_code_idx').on(t.code),
    index('invites_creator_idx').on(t.creatorId),
    index('invites_server_idx').on(t.serverId),
    index('invites_expires_idx').on(t.expiresAt),
    index('invites_uses_idx').on(t.uses)
  ]
);

const activityLog = pgTable(
  'activity_log',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    details: jsonb('details').$type<
      TActivityLogDetailsMap[keyof TActivityLogDetailsMap]
    >(),
    ip: text('ip'),
    serverId: integer('server_id').references(() => servers.id, {
      onDelete: 'cascade'
    }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    index('activity_log_user_idx').on(t.userId),
    index('activity_log_type_idx').on(t.type),
    index('activity_log_created_idx').on(t.createdAt),
    index('activity_log_user_created_idx').on(t.userId, t.createdAt),
    index('activity_log_type_created_idx').on(t.type, t.createdAt),
    index('activity_log_server_idx').on(t.serverId)
  ]
);

const channelRolePermissions = pgTable(
  'channel_role_permissions',
  {
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    roleId: integer('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    allow: boolean('allow').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.roleId, t.permission] }),
    index('channel_role_permissions_channel_idx').on(t.channelId),
    index('channel_role_permissions_role_idx').on(t.roleId),
    index('channel_role_permissions_channel_perm_idx').on(
      t.channelId,
      t.permission
    ),
    index('channel_role_permissions_role_perm_idx').on(t.roleId, t.permission),
    index('channel_role_permissions_allow_idx').on(t.allow)
  ]
);

const channelUserPermissions = pgTable(
  'channel_user_permissions',
  {
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    permission: text('permission').notNull(),
    allow: boolean('allow').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId, t.permission] }),
    index('channel_user_permissions_channel_idx').on(t.channelId),
    index('channel_user_permissions_user_idx').on(t.userId),
    index('channel_user_permissions_channel_perm_idx').on(
      t.channelId,
      t.permission
    ),
    index('channel_user_permissions_user_perm_idx').on(t.userId, t.permission),
    index('channel_user_permissions_allow_idx').on(t.allow)
  ]
);

const channelReadStates = pgTable(
  'channel_read_states',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    lastReadMessageId: integer('last_read_message_id').references(
      () => messages.id,
      { onDelete: 'set null' }
    ),
    lastReadAt: bigint('last_read_at', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.channelId] }),
    index('channel_read_states_user_idx').on(t.userId),
    index('channel_read_states_channel_idx').on(t.channelId),
    index('channel_read_states_last_read_idx').on(t.lastReadMessageId)
  ]
);

const pluginData = pgTable(
  'plugin_data',
  {
    pluginId: text('plugin_id').notNull(),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    settings: jsonb('settings')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({})
  },
  (t) => [
    primaryKey({ columns: [t.pluginId, t.serverId] }),
    index('plugin_data_server_idx').on(t.serverId)
  ]
);

const friendships = pgTable(
  'friendships',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendId: integer('friend_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    index('friendships_user_idx').on(t.userId),
    index('friendships_friend_idx').on(t.friendId),
    uniqueIndex('friendships_pair_idx').on(t.userId, t.friendId)
  ]
);

const friendRequests = pgTable(
  'friend_requests',
  {
    id: serial('id').primaryKey(),
    senderId: integer('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    receiverId: integer('receiver_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('pending'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('friend_requests_sender_idx').on(t.senderId),
    index('friend_requests_receiver_idx').on(t.receiverId),
    index('friend_requests_status_idx').on(t.status),
    uniqueIndex('friend_requests_pair_idx').on(t.senderId, t.receiverId)
  ]
);

const channelNotificationSettings = pgTable(
  'channel_notification_settings',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    level: text('level').notNull().default('default'),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.channelId] }),
    index('channel_notif_user_idx').on(t.userId),
    index('channel_notif_channel_idx').on(t.channelId)
  ]
);

const dmChannels = pgTable('dm_channels', {
  id: serial('id').primaryKey(),
  name: text('name'),
  ownerId: integer('owner_id').references(() => users.id, {
    onDelete: 'set null'
  }),
  iconFileId: integer('icon_file_id').references(() => files.id, {
    onDelete: 'set null'
  }),
  isGroup: boolean('is_group').notNull().default(false),
  e2ee: boolean('e2ee').notNull().default(true),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' })
});

const dmChannelMembers = pgTable(
  'dm_channel_members',
  {
    dmChannelId: integer('dm_channel_id')
      .notNull()
      .references(() => dmChannels.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.dmChannelId, t.userId] }),
    index('dm_channel_members_channel_idx').on(t.dmChannelId),
    index('dm_channel_members_user_idx').on(t.userId)
  ]
);

const dmMessages = pgTable(
  'dm_messages',
  {
    id: serial('id').primaryKey(),
    content: text('content'),
    encryptedContent: text('encrypted_content'),
    e2ee: boolean('e2ee').notNull().default(false),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dmChannelId: integer('dm_channel_id')
      .notNull()
      .references(() => dmChannels.id, { onDelete: 'cascade' }),
    metadata: jsonb('metadata').$type<TMessageMetadata[]>(),
    replyToId: integer('reply_to_id'),
    pinned: boolean('pinned').notNull().default(false),
    pinnedAt: bigint('pinned_at', { mode: 'number' }),
    pinnedBy: integer('pinned_by').references(() => users.id, {
      onDelete: 'set null'
    }),
    edited: boolean('edited').notNull().default(false),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('dm_messages_user_idx').on(t.userId),
    index('dm_messages_channel_idx').on(t.dmChannelId),
    index('dm_messages_created_idx').on(t.createdAt),
    index('dm_messages_channel_created_idx').on(t.dmChannelId, t.createdAt),
    index('dm_messages_pinned_idx').on(t.pinned),
    index('dm_messages_channel_pinned_idx').on(t.dmChannelId, t.pinned)
  ]
);

const dmMessageFiles = pgTable(
  'dm_message_files',
  {
    dmMessageId: integer('dm_message_id')
      .notNull()
      .references(() => dmMessages.id, { onDelete: 'cascade' }),
    fileId: integer('file_id')
      .notNull()
      .references(() => files.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.dmMessageId, t.fileId] }),
    index('dm_message_files_msg_idx').on(t.dmMessageId),
    index('dm_message_files_file_idx').on(t.fileId)
  ]
);

const dmMessageReactions = pgTable(
  'dm_message_reactions',
  {
    dmMessageId: integer('dm_message_id')
      .notNull()
      .references(() => dmMessages.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    emoji: text('emoji').notNull(),
    fileId: integer('file_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.dmMessageId, t.userId, t.emoji] }),
    index('dm_reaction_msg_idx').on(t.dmMessageId),
    index('dm_reaction_emoji_idx').on(t.emoji),
    index('dm_reaction_user_idx').on(t.userId)
  ]
);

const dmReadStates = pgTable(
  'dm_read_states',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    dmChannelId: integer('dm_channel_id')
      .notNull()
      .references(() => dmChannels.id, { onDelete: 'cascade' }),
    lastReadMessageId: integer('last_read_message_id').references(
      () => dmMessages.id,
      { onDelete: 'set null' }
    ),
    lastReadAt: bigint('last_read_at', { mode: 'number' }).notNull()
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.dmChannelId] }),
    index('dm_read_states_user_idx').on(t.userId),
    index('dm_read_states_channel_idx').on(t.dmChannelId)
  ]
);

const forumTags = pgTable(
  'forum_tags',
  {
    id: serial('id').primaryKey(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull().default('#808080'),
    emojiId: integer('emoji_id').references(() => emojis.id, {
      onDelete: 'set null'
    }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [index('forum_tags_channel_idx').on(t.channelId)]
);

const forumPostTags = pgTable(
  'forum_post_tags',
  {
    threadId: integer('thread_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => forumTags.id, { onDelete: 'cascade' })
  },
  (t) => [primaryKey({ columns: [t.threadId, t.tagId] })]
);

const webhooks = pgTable(
  'webhooks',
  {
    id: serial('id').primaryKey(),
    name: text('name').notNull(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    avatarFileId: integer('avatar_file_id').references(() => files.id, {
      onDelete: 'set null'
    }),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    uniqueIndex('webhooks_token_idx').on(t.token),
    index('webhooks_channel_idx').on(t.channelId),
    index('webhooks_server_idx').on(t.serverId)
  ]
);

const automodRules = pgTable(
  'automod_rules',
  {
    id: serial('id').primaryKey(),
    serverId: integer('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    config: jsonb('config').notNull(),
    actions: jsonb('actions').notNull(),
    exemptRoleIds: jsonb('exempt_role_ids').$type<number[]>().notNull().default([]),
    exemptChannelIds: jsonb('exempt_channel_ids')
      .$type<number[]>()
      .notNull()
      .default([]),
    createdBy: integer('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('automod_rules_server_idx').on(t.serverId),
    index('automod_rules_type_idx').on(t.type),
    index('automod_rules_enabled_idx').on(t.enabled)
  ]
);

const userNotes = pgTable(
  'user_notes',
  {
    id: serial('id').primaryKey(),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetUserId: integer('target_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    index('user_notes_author_idx').on(t.authorId),
    index('user_notes_target_idx').on(t.targetUserId),
    index('user_notes_author_target_idx').on(t.authorId, t.targetUserId)
  ]
);

const federationKeys = pgTable('federation_keys', {
  id: serial('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
});

const federationInstances = pgTable(
  'federation_instances',
  {
    id: serial('id').primaryKey(),
    domain: text('domain').notNull(),
    name: text('name'),
    publicKey: text('public_key'),
    status: text('status').notNull().default('pending'),
    direction: text('direction').notNull(),
    addedBy: integer('added_by').references(() => users.id, {
      onDelete: 'set null'
    }),
    lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
    createdAt: bigint('created_at', { mode: 'number' }).notNull(),
    updatedAt: bigint('updated_at', { mode: 'number' })
  },
  (t) => [
    uniqueIndex('federation_instances_domain_idx').on(t.domain),
    index('federation_instances_status_idx').on(t.status)
  ]
);

// E2EE tables

const userIdentityKeys = pgTable('user_identity_keys', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  identityPublicKey: text('identity_public_key').notNull(),
  registrationId: integer('registration_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull()
});

const userSignedPreKeys = pgTable(
  'user_signed_pre_keys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyId: integer('key_id').notNull(),
    publicKey: text('public_key').notNull(),
    signature: text('signature').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    index('user_signed_pre_keys_user_idx').on(t.userId),
    uniqueIndex('user_signed_pre_keys_user_key_idx').on(t.userId, t.keyId)
  ]
);

const userOneTimePreKeys = pgTable(
  'user_one_time_pre_keys',
  {
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyId: integer('key_id').notNull(),
    publicKey: text('public_key').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    index('user_otp_keys_user_idx').on(t.userId),
    uniqueIndex('user_otp_keys_user_key_idx').on(t.userId, t.keyId)
  ]
);

const userKeyBackups = pgTable('user_key_backups', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  encryptedData: text('encrypted_data').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull()
});

const e2eeSenderKeys = pgTable(
  'e2ee_sender_keys',
  {
    id: serial('id').primaryKey(),
    channelId: integer('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    fromUserId: integer('from_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    toUserId: integer('to_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    distributionMessage: text('distribution_message').notNull(),
    createdAt: bigint('created_at', { mode: 'number' }).notNull()
  },
  (t) => [
    index('e2ee_sender_keys_channel_idx').on(t.channelId),
    index('e2ee_sender_keys_from_idx').on(t.fromUserId),
    index('e2ee_sender_keys_to_idx').on(t.toUserId),
    index('e2ee_sender_keys_channel_to_idx').on(t.channelId, t.toUserId)
  ]
);

export {
  activityLog,
  automodRules,
  categories,
  channelNotificationSettings,
  channelReadStates,
  channelRolePermissions,
  channels,
  channelUserPermissions,
  dmChannelMembers,
  dmChannels,
  dmMessageFiles,
  dmMessageReactions,
  dmMessages,
  dmReadStates,
  e2eeSenderKeys,
  emojis,
  federationInstances,
  federationKeys,
  files,
  forumPostTags,
  forumTags,
  friendRequests,
  friendships,
  invites,
  logins,
  messageFiles,
  messageReactions,
  messages,
  pluginData,
  rolePermissions,
  roles,
  serverMembers,
  servers,
  settings,
  userIdentityKeys,
  userKeyBackups,
  userNotes,
  userOneTimePreKeys,
  userRoles,
  userSignedPreKeys,
  users,
  webhooks
};
