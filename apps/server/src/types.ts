/**
 * Types the server publishes for its clients — reachable as
 * `@pulse/server/types` (package.json `exports`). Everything here is
 * derived from the database schema or the tRPC router, which is why it
 * lives in the server and not in @pulse/shared: shared must stay a
 * standalone package (no reach into apps/server, no drizzle-orm), so
 * that the plugin SDK and the client can consume it without pulling
 * the server's dependency graph in behind it.
 *
 * Type-only on purpose. A value import of the schema from here would
 * evaluate the entire Drizzle table layout inside the client bundle;
 * consumers must `import type` from this module and nothing else.
 */
import type { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import type {
  ActivityLogType,
  ChannelType,
  Permission,
  TAuthProvider,
  TIceServer,
  TIceTransportPolicy,
  UserStatus
} from '@pulse/shared';
import type {
  activityLog,
  automodRules,
  categories,
  channelNotificationSettings,
  channelReadStates,
  channelRolePermissions,
  channelUserPermissions,
  channels,
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
  nameplates,
  rolePermissions,
  roles,
  serverMembers,
  servers,
  settings,
  userIdentityKeys,
  userOneTimePreKeys,
  userPreferences,
  userRoles,
  userSignedPreKeys,
  users,
  webhooks
} from './db/schema';

export type { AppRouter } from './routers';

// -------------------- table rows --------------------

export type TSettings = InferSelectModel<typeof settings>;
export type TServer = InferSelectModel<typeof servers>;
export type TServerMember = InferSelectModel<typeof serverMembers>;
export type TRole = InferSelectModel<typeof roles>;
export type TCategory = InferSelectModel<typeof categories>;
export type TChannel = InferSelectModel<typeof channels>;
export type TFile = InferSelectModel<typeof files> & {
  _accessToken?: string;
};
export type TFileRef = Pick<TFile, 'id' | 'name'>;
export type TUser = InferSelectModel<typeof users>;
export type TLogin = InferSelectModel<typeof logins>;
export type TMessage = InferSelectModel<typeof messages>;
export type TMessageFile = InferSelectModel<typeof messageFiles>;
export type TRolePermission = InferSelectModel<typeof rolePermissions>;
export type TEmoji = InferSelectModel<typeof emojis>;
export type TMessageReaction = InferSelectModel<typeof messageReactions>;
export type TInvite = InferSelectModel<typeof invites>;
export type TActivityLog = InferSelectModel<typeof activityLog>;
export type TUserRole = InferSelectModel<typeof userRoles>;
export type TChannelRolePermission = InferSelectModel<
  typeof channelRolePermissions
>;
export type TChannelUserPermission = InferSelectModel<
  typeof channelUserPermissions
>;
export type TChannelReadState = InferSelectModel<typeof channelReadStates>;

export type TISettings = InferInsertModel<typeof settings>;
export type TIServer = InferInsertModel<typeof servers>;
export type TIServerMember = InferInsertModel<typeof serverMembers>;
export type TIRole = InferInsertModel<typeof roles>;
export type TICategory = InferInsertModel<typeof categories>;
export type TIChannel = InferInsertModel<typeof channels>;
export type TIFile = InferInsertModel<typeof files>;
export type TIUser = InferInsertModel<typeof users>;
export type TILogin = InferInsertModel<typeof logins>;
export type TIMessage = InferInsertModel<typeof messages>;
export type TIMessageFile = InferInsertModel<typeof messageFiles>;
export type TIRolePermission = InferInsertModel<typeof rolePermissions>;
export type TIEmoji = InferInsertModel<typeof emojis>;
export type TIMessageReaction = InferInsertModel<typeof messageReactions>;
export type TIInvite = InferInsertModel<typeof invites>;
export type TIActivityLog = InferInsertModel<typeof activityLog>;
export type TIUserRole = InferInsertModel<typeof userRoles>;
export type TIChannelRolePermission = InferInsertModel<
  typeof channelRolePermissions
>;
export type TIChannelUserPermission = InferInsertModel<
  typeof channelUserPermissions
>;
export type TIChannelReadState = InferInsertModel<typeof channelReadStates>;

export type TChannelNotificationSetting = InferSelectModel<typeof channelNotificationSettings>;
export type TForumTag = InferSelectModel<typeof forumTags>;
export type TForumPostTag = InferSelectModel<typeof forumPostTags>;

export type TFriendship = InferSelectModel<typeof friendships>;
export type TFriendRequest = InferSelectModel<typeof friendRequests>;
export type TDmChannel = InferSelectModel<typeof dmChannels>;
export type TDmChannelMember = InferSelectModel<typeof dmChannelMembers>;
export type TDmMessage = InferSelectModel<typeof dmMessages>;
export type TDmMessageFile = InferSelectModel<typeof dmMessageFiles>;
export type TDmMessageReaction = InferSelectModel<typeof dmMessageReactions>;
export type TDmReadState = InferSelectModel<typeof dmReadStates>;
export type TWebhook = InferSelectModel<typeof webhooks>;
export type TIWebhook = InferInsertModel<typeof webhooks>;
export type TAutomodRule = InferSelectModel<typeof automodRules>;
export type TIAutomodRule = InferInsertModel<typeof automodRules>;
export type TFederationKey = InferSelectModel<typeof federationKeys>;
export type TFederationInstance = InferSelectModel<typeof federationInstances>;
export type TUserIdentityKey = InferSelectModel<typeof userIdentityKeys>;
export type TUserSignedPreKey = InferSelectModel<typeof userSignedPreKeys>;
export type TUserOneTimePreKey = InferSelectModel<typeof userOneTimePreKeys>;
export type TUserPreference = InferSelectModel<typeof userPreferences>;
export type TIUserPreference = InferInsertModel<typeof userPreferences>;
export type TE2eeSenderKey = InferSelectModel<typeof e2eeSenderKeys>;
export type TNameplate = InferSelectModel<typeof nameplates>;
export type TINameplate = InferInsertModel<typeof nameplates>;

export type TStorageSettings = Pick<
  TSettings,
  | 'storageUploadEnabled'
  | 'storageQuota'
  | 'storageUploadMaxFileSize'
  | 'storageSpaceQuotaByUser'
  | 'storageOverflowAction'
>;

// joined types

type TPublicUser = Pick<
  TJoinedUser,
  | 'id'
  | 'name'
  | 'publicId'
  | 'bannerColor'
  | 'bio'
  | 'pronouns'
  | 'nameplate'
  | 'avatarDecoration'
  | 'nameStyle'
  | 'customStatus'
  | 'customStatusEmoji'
  | 'avatar'
  | 'avatarId'
  | 'banner'
  | 'bannerId'
  | 'banned'
  | 'deletedAt'
  | 'createdAt'
> & {
  status?: UserStatus;
  _identity?: string;
  /** For a shadow of a federated user: the publicId their HOME instance
   *  issued — the one identity every instance agrees on. `publicId` on a
   *  shadow row is minted locally and differs per instance. Absent (or
   *  null) for local users. */
  federatedPublicId?: string | null;
};

export type TJoinedRole = TRole & {
  permissions: Permission[];
};

/**
 * The reactor's identity, denormalized onto each reaction so the client
 * can show 'who reacted' on hover without a roster lookup. Roster lookup
 * fails in exactly the cases that matter — DMs (home id-space, not the
 * ambient server roster), federated shadow users, and members who have
 * since left — so name/avatar travel with the reaction instead. Null only
 * when the reactor's user row no longer exists.
 */
export type TReactionUser = {
  id: number;
  name: string;
  avatar: TFileRef | null;
};

export type TJoinedMessageReaction = TMessageReaction & {
  file: TFile | null;
  user: TReactionUser | null;
};

export type TMessageReplyPreview = {
  id: number;
  content: string | null;
  userId: number;
  // Distinguishes a deleted message (no row) from a file-only message
  // (row exists, content null, attachments present). Without this flag
  // the reply preview shows 'Message deleted' for any null content,
  // including legitimate file uploads.
  hasFiles?: boolean;
  // True when the parent message is E2EE — content is the ciphertext.
  // The client decrypts during message-decrypt rather than rendering
  // the raw envelope JSON.
  e2ee?: boolean;
};

export type TJoinedMessage = TMessage & {
  files: TFile[];
  reactions: TJoinedMessageReaction[];
  replyTo?: TMessageReplyPreview | null;
};

export type TJoinedEmoji = TEmoji & {
  file: TFile;
  user?: TPublicUser;
};

// Member-facing view of a nameplate pack — enough for the client to
// render the image (files are served by name) without leaking the
// full files row.
export type TJoinedNameplate = Pick<TNameplate, 'id' | 'name'> & {
  file: TFileRef;
};

export type TJoinedUser = TUser & {
  avatar: TFileRef | null;
  banner: TFileRef | null;
  roleIds: number[];
};

export type TJoinedPublicUser = Omit<TPublicUser, 'avatar' | 'banner'> & {
  avatar: TFileRef | null;
  banner: TFileRef | null;
  roleIds: number[];
  nickname?: string | null;
};

export type TJoinedSettings = TSettings & {
  logo: TFile | null;
};

export type TJoinedServer = TServer & {
  logo: TFile | null;
};

export type TServerSummary = {
  id: number;
  name: string;
  publicId: string;
  logo: TFile | null;
  memberCount?: number;
  ownerId?: number | null;
  description?: string | null;
  hasPassword?: boolean;
};

export type TJoinedInvite = TInvite & {
  creator: TJoinedPublicUser;
};

export type TJoinedFriendRequest = TFriendRequest & {
  sender: TJoinedPublicUser;
  receiver: TJoinedPublicUser;
};

export type TJoinedDmChannel = TDmChannel & {
  members: TJoinedPublicUser[];
  lastMessage?: TDmMessage | null;
  unreadCount: number;
};

export type TJoinedDmMessageReaction = TDmMessageReaction & {
  file: TFile | null;
  user: TReactionUser | null;
};

export type TJoinedDmMessage = TDmMessage & {
  files: TFile[];
  reactions: TJoinedDmMessageReaction[];
  replyTo?: TMessageReplyPreview | null;
};

// -------------------- row-derived API shapes --------------------

export type TPublicServerSettings = Pick<
  TServer,
  | 'id'
  | 'name'
  | 'description'
  | 'publicId'
  | 'storageUploadEnabled'
  | 'storageQuota'
  | 'storageUploadMaxFileSize'
  | 'storageSpaceQuotaByUser'
  | 'storageOverflowAction'
  | 'enablePlugins'
> & {
  /** Current server logo, so clients can live-update the server rail on
   *  SERVER_SETTINGS_UPDATE without a refetch. Optional — older servers
   *  don't send it. */
  logo?: TFile | null;
};

export type TOwnUser = TUser;

export type TServerInfo = Pick<
  TSettings,
  'serverId' | 'name' | 'description' | 'allowNewUsers'
> & {
  id?: number;
  logo: TFile | null;
  version: string;
  registrationDisabled?: boolean;
  /** Whether email/password self-registration is enabled. When false, the
   * client hides the Create Account form (unless an invite link is present).
   * Absent = enabled (backwards compat with older servers). */
  passwordRegistrationEnabled?: boolean;
  /** Derived SSO-only flag: false when password registration is disabled
   * AND at least one SSO provider is advertised. The client then hides the
   * email/password login form (unless an invite link is present) and the
   * server rejects password logins. Absent = enabled (backwards compat). */
  passwordLoginEnabled?: boolean;
  enabledAuthProviders?: TAuthProvider[];
  supabaseUrl: string;
  supabaseAnonKey: string;
  giphyApiKey?: string;
  /** Instance-global screen-share ceiling. The client offers every quality
   * rung at or below these and clamps its capture to them. Absent = no cap
   * advertised (older servers); the client falls back to its own defaults. */
  maxScreenResolution?: string;
  maxScreenFramerate?: number;
  /** Optional ICE relay configuration the operator set for clients that
   * cannot reach the media port directly (UDP and TCP both blocked). The
   * SFU is ICE-lite with an announced public address, so STUN is never
   * needed and the server itself never uses a relay; the client passes
   * these to both WebRTC transports as-is. Absent = no relay. */
  iceServers?: TIceServer[];
  /** `relay` forces every client through the configured TURN servers
   * (diagnostics / locked-down networks); default `all`. */
  iceTransportPolicy?: TIceTransportPolicy;
};

export type TRemoteServerSummary = {
  publicId: string;
  name: string;
  description: string | null;
  logo: TFile | null;
  memberCount: number;
  instanceDomain: string;
  instanceName: string;
  hasPassword?: boolean;
};

// -------------------- activity log details --------------------
// Keyed by ActivityLogType (the enum stays in @pulse/shared); the
// UPDATED_* payloads carry partial rows, which is what ties the map to
// the schema.

export type TActivityLogDetailsMap = {
  [ActivityLogType.SERVER_STARTED]: Record<string, never>;
  [ActivityLogType.EDIT_SERVER_SETTINGS]: {
    // The updateSettings input: the settings columns plus the numeric
    // serverId the route is scoped to (TSettings.serverId is the text
    // column, hence the override).
    values: Partial<Omit<TSettings, 'serverId'>> & { serverId?: number };
  };
  // -------------------- USERS --------------------
  [ActivityLogType.USER_KICKED]: {
    reason: string | undefined;
    kickedBy: number;
  };
  [ActivityLogType.USER_BANNED]: {
    reason: string | undefined;
    bannedBy: number;
  };
  [ActivityLogType.USER_UNBANNED]: {
    unbannedBy: number;
  };
  [ActivityLogType.USER_ROLE_ASSIGNED]: {
    roleId: number;
    roleName: string;
    assignedBy: number;
  };
  [ActivityLogType.USER_ROLE_REMOVED]: {
    roleId: number;
    roleName: string;
    removedBy: number;
  };
  [ActivityLogType.USER_NICKNAME_SET]: {
    nickname: string | null;
    setBy: number;
  };
  [ActivityLogType.USER_CREATED]: {
    inviteCode: string | undefined;
    username: string;
  };
  [ActivityLogType.USER_JOINED]: {
    inviteCode: string | undefined;
  };
  [ActivityLogType.USER_LEFT]: Record<string, never>;
  [ActivityLogType.USER_UPDATED_PASSWORD]: Record<string, never>;
  [ActivityLogType.USER_DELETED_ACCOUNT]: Record<string, never>;
  [ActivityLogType.USER_REPORTED]: {
    reportId: number;
    kind: string;
    reason: string;
    reportedBy: number;
  };
  [ActivityLogType.REPORT_RESOLVED]: {
    reportId: number;
    action: string;
    resolvedBy: number;
  };
  [ActivityLogType.REPORT_ESCALATED]: {
    reportId: number;
    reason: string;
    escalatedBy: number | null;
  };
  [ActivityLogType.SERVER_DELETED]: {
    serverId: number;
    serverName: string;
    serverPublicId: string;
    deletedBy: number;
  };
  // -------------------- ROLES --------------------
  [ActivityLogType.CREATED_ROLE]: {
    roleId: number;
    roleName: string;
  };
  [ActivityLogType.DELETED_ROLE]: {
    roleId: number;
    roleName: string;
  };
  [ActivityLogType.UPDATED_ROLE]: {
    roleId: number;
    permissions: string[];
    values: Partial<TRole>;
  };
  [ActivityLogType.UPDATED_DEFAULT_ROLE]: {
    newRoleId: number;
    oldRoleId: number;
    newRoleName: string;
    oldRoleName: string;
  };
  // -------------------- CHANNELS --------------------
  [ActivityLogType.CREATED_CHANNEL]: {
    channelId: number;
    channelName: string;
    type: ChannelType;
  };
  [ActivityLogType.DELETED_CHANNEL]: {
    channelId: number;
    channelName: string;
  };
  [ActivityLogType.UPDATED_CHANNEL]: {
    channelId: number;
    values: Partial<TChannel>;
  };
  [ActivityLogType.UPDATED_CHANNEL_PERMISSIONS]: {
    channelId: number;
    targetUserId?: number;
    targetRoleId?: number;
    permissions: {
      permission: string;
      allow: boolean;
    }[];
  };
  [ActivityLogType.DELETED_CHANNEL_PERMISSIONS]: {
    channelId: number;
    targetUserId?: number;
    targetRoleId?: number;
  };
  [ActivityLogType.ROTATE_CHANNEL_FILE_ACCESS_TOKEN]: {
    channelId: number;
  };
  // -------------------- INVITES --------------------
  [ActivityLogType.CREATED_INVITE]: {
    code: string;
    maxUses: number;
    expiresAt: number | null;
  };
  [ActivityLogType.DELETED_INVITE]: {
    code: string;
  };
  [ActivityLogType.USED_INVITE]: {
    code: string;
  };
  // -------------------- EMOJIS --------------------
  [ActivityLogType.CREATED_EMOJI]: {
    name: string;
  };
  [ActivityLogType.DELETED_EMOJI]: {
    name: string;
  };
  [ActivityLogType.UPDATED_EMOJI]: {
    fromName: string;
    toName: string;
  };
  // -------------------- CATEGORIES --------------------
  [ActivityLogType.CREATED_CATEGORY]: {
    categoryId: number;
    categoryName: string;
  };
  [ActivityLogType.DELETED_CATEGORY]: {
    categoryId: number;
    categoryName: string;
  };
  [ActivityLogType.UPDATED_CATEGORY]: {
    categoryId: number;
    values: Partial<{
      name: string;
      position: number;
    }>;
  };
  // -------------------- PLUGINS --------------------
  [ActivityLogType.EXECUTED_PLUGIN_COMMAND]: {
    pluginId: string;
    commandName: string;
    args: Record<string, unknown>;
  };
  [ActivityLogType.PLUGIN_TOGGLED]: {
    pluginId: string;
    enabled: boolean;
  };
};

export type TActivityLogDetails<T extends ActivityLogType = ActivityLogType> = {
  type: T;
  details: TActivityLogDetailsMap[T];
};
