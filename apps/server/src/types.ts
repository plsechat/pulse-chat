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
  bridgeLinks,
  bridgeServerLinks,
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
  eventRosterTemplates,
  eventSignups,
  events,
  externalIdentities,
  federationInstances,
  federationKeys,
  files,
  forumPostTags,
  forumTags,
  friendRequests,
  friendships,
  importJobs,
  invites,
  logins,
  messageFiles,
  messageReactions,
  messages,
  nameplates,
  serverSounds,
  pluginMessageLinks,
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
export type TServerSound = InferSelectModel<typeof serverSounds>;
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
  /** The reactor's cross-instance identity; the avatar placeholder is
   *  keyed on it so the person looks the same on every surface. */
  publicId: string;
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
  /** Set on server-scoped updates: the member's timeout deadline (ms). */
  timedOutUntil?: number | null;
  /** A plugin's own account (it posts as the plugin, nobody signs in as it). */
  system?: boolean;
  /**
   * What the member is playing, as reported by their desktop shell.
   * Only server-scoped projections carry it (the roster and the scoped
   * USER_UPDATE), and only where the member shares it on THAT server —
   * the global projection never does, so a DM partner or a friend who
   * shares no un-hidden server with them never sees it. `null` means
   * not playing (or not sharing here); absent means "not this
   * projection's concern — keep what you had".
   */
  gamePresence?: TGamePresence | null;
  /**
   * Set on a server-scoped USER_UPDATE: the publicId of the server the
   * update is about. A client viewing another server must not take the
   * per-server fields (gamePresence) from it.
   */
  scopeServerPublicId?: string;
};

/** A game the desktop shell detected: its name and when it started (ms). */
export type TGamePresence = {
  name: string;
  startedAt: number;
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
  /**
   * Group icon as a public file ref (`/public/<name>`); only the channel
   * list (getDmChannelsForUser) resolves it — single-channel
   * projections leave it undefined and the client refetches the list on
   * DM_CHANNEL_UPDATE.
   */
  icon?: TFileRef | null;
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
  // -------------------- SOUNDS --------------------
  [ActivityLogType.CREATED_SOUND]: {
    name: string;
  };
  [ActivityLogType.DELETED_SOUND]: {
    name: string;
  };
  [ActivityLogType.UPDATED_SOUND]: {
    name: string;
    changed: string[];
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

// -------------------- EVENTS (raid planner) --------------------
export type TEvent = InferSelectModel<typeof events>;
export type TEventSignup = InferSelectModel<typeof eventSignups>;
export type TEventRosterTemplate = InferSelectModel<typeof eventRosterTemplates>;
/** One roster slot definition; `cap` null = unlimited. */
export type TEventRole = TEvent['roles'][number];
export type TEventStatus = TEvent['status'];
export type TEventSignupStatus = TEventSignup['status'];
/** Roster totals fanned out with EVENT_SIGNUPS_UPDATE and on every list row. */
export type TEventRosterCounts = {
  byRole: Record<string, { confirmed: number; bench: number }>;
  confirmed: number;
  bench: number;
  declined: number;
};
export type TEventListItem = TEvent & {
  counts: TEventRosterCounts;
  ownSignup: Pick<TEventSignup, 'roleKey' | 'status' | 'position'> | null;
};
export type TEventRoster = {
  /** In the event's role order; every role is present even when empty. */
  confirmed: { role: TEventRole; signups: TEventSignup[] }[];
  /** Bench order = promotion order. A benched signup whose role was removed keeps its old key. */
  bench: TEventSignup[];
  declined: number;
};
export type TEventDetail = {
  event: TEvent;
  counts: TEventRosterCounts;
  roster: TEventRoster;
  host: Pick<TJoinedPublicUser, 'id' | 'name' | 'avatar'> | null;
};

// -------------------- PLUGIN SDK --------------------
/** One row of plugin_message_links: a plugin's own id for a message it posted. */
export type TPluginMessageLink = InferSelectModel<typeof pluginMessageLinks>;

// -------------------- COMMUNITY IMPORT --------------------
export type TImportJob = InferSelectModel<typeof importJobs>;
export type TExternalIdentity = InferSelectModel<typeof externalIdentities>;
export type TImportJobStatus = TImportJob['status'];
/** The job's steps, in the order they run. */
export type TImportStep =
  | 'guild'
  | 'categories'
  | 'channels'
  | 'roles'
  | 'emojis'
  | 'members'
  | 'pins'
  | 'threads'
  | 'messages'
  | 'events';
export type TImportStepCounts = {
  done: number;
  /** Null until the step knows how much work there is (estimates included). */
  total: number | null;
  skipped: number;
};
export type TImportError = {
  step: TImportStep;
  /** What failed: a channel name, a file name, a member — never an id alone. */
  ref: string;
  message: string;
  at: number;
};
export type TImportHistoryOption = 'all' | 'last30days' | 'last1000' | 'none';
export type TImportOptions = {
  guildId: string;
  history: TImportHistoryOption;
  attachments: 'download' | 'skip';
  members: 'posters' | 'everyone' | 'nobody';
  roles: 'import' | 'skip';
};
export type TImportGuildSummary = {
  id: string;
  name: string;
  iconUrl: string | null;
  approximateMemberCount: number | null;
  approximatePresenceCount: number | null;
};
/** Why messages were left behind: service notices, nothing to show, channels the bot cannot read. */
export type TImportSkipReasons = { type: number; empty: number; unreadable: number };
/** What the wizard shows while the job runs and after it ends. */
export type TImportProgressView = {
  counts: Partial<Record<TImportStep, TImportStepCounts>>;
  attachments: { done: number; failed: number; skipped: number };
  skippedBy: TImportSkipReasons;
  errors: TImportError[];
  stepsDone: TImportStep[];
  startedAt: number | null;
  finishedAt: number | null;
};
export type TImportJobView = {
  id: number;
  serverId: number;
  createdBy: number | null;
  source: string;
  status: TImportJobStatus;
  step: TImportStep | null;
  options: TImportOptions | null;
  progress: TImportProgressView;
  error: string | null;
  guild: TImportGuildSummary | null;
  bot: { id: string; name: string } | null;
  createdAt: number;
  updatedAt: number;
};
/** An imported person still waiting for their owner: a placeholder member and what they authored here. */
export type TImportedPerson = {
  userId: number;
  name: string;
  avatarId: number | null;
  provider: string;
  importedAt: number;
  messageCount: number;
};
export type TImportBotRequirement = { name: string; why: string };
export type TImportPreview = {
  guild: TImportGuildSummary;
  counts: {
    categories: number;
    channels: { text: number; voice: number; forum: number; skipped: number };
    roles: number;
    emojis: number;
    members: number | null;
    threads: number;
    scheduledEvents: number;
    estimatedMessages: number;
  };
  estimatedSeconds: number;
  /** The message estimate under each history depth, for the Options step. */
  estimateByDepth: Record<TImportHistoryOption, number>;
  warnings: string[];
  unreadableChannels: string[];
};

// -------------------- CHANNEL BRIDGE --------------------
/** One row of bridge_links: a local channel mirrored to a remote one by an official bridge plugin. */
export type TBridgeLink = InferSelectModel<typeof bridgeLinks>;
export type TBridgeDirection = TBridgeLink['direction'];
/** What the Bridge tab sees: never the webhook token ciphertext. */
export type TBridgeLinkView = Omit<TBridgeLink, 'webhookTokenCiphertext' | 'pluginId'>;
export type TBridgeRemoteGuild = { id: string; name: string; iconUrl: string | null };
export type TBridgeRemoteChannel = {
  id: string;
  guildId: string;
  name: string;
  parentName: string | null;
  position: number;
};
export type TBridgeStatus = {
  /** The bridge plugin is loaded; the tab is offered only then. */
  available: boolean;
  /** Plaintext text channel (the only kind a bridge can mirror). */
  bridgeable: boolean;
  /** A bot token is set in the plugin's settings. */
  configured: boolean;
  connected: boolean;
  botUser: { id: string; name: string } | null;
  /** The gateway's last error, or the fatal reason it stopped. */
  lastError: string | null;
  link: TBridgeLinkView | null;
  mirroredToday: number;
  /** The last failure mirroring this channel, if any. */
  linkError: string | null;
  /** The whole-server link this channel falls under, when the server has one. */
  serverLink: TBridgeServerLinkSummary | null;
};

// -------------------- WHOLE-SERVER BRIDGE --------------------
/** One row of bridge_server_links: a community linked to one remote server. */
export type TBridgeServerLink = InferSelectModel<typeof bridgeServerLinks>;
/** `match`: same-name channels pair; `mirror`: match AND create what is missing. */
export type TBridgeMode = TBridgeServerLink['mode'];
/** Which side gets the channels it lacks (mirror mode only). */
export type TBridgeCreateMissing = TBridgeServerLink['createMissing'];
export type TBridgeServerLinkView = Omit<TBridgeServerLink, 'pluginId'>;
/** What the channel tab needs to know about the server link above it. */
export type TBridgeServerLinkSummary = {
  id: number;
  remoteGuildId: string;
  /** From the plugin's guild cache; null until the gateway has seen the guild. */
  remoteGuildName: string | null;
  mode: TBridgeMode;
  defaultDirection: TBridgeDirection;
};
/** `plugin`: the bridge plugin signalled a remote change; `load`: the plugin (re)loaded. */
export type TBridgeSyncTrigger = 'link' | 'manual' | 'channel-created' | 'tick' | 'status' | 'plugin' | 'load';
/** A channel a sync left alone, and why, in the owner's words. */
export type TBridgeSkippedChannel = {
  name: string;
  side: 'here' | 'there';
  reason: string;
};
/** The outcome of one sync run; persisted on the server link (last_report) so the status survives a restart. */
export type TBridgeSyncReport = {
  trigger: TBridgeSyncTrigger;
  startedAt: number;
  finishedAt: number | null;
  paired: number;
  createdHere: number;
  createdThere: number;
  removed: number;
  skipped: TBridgeSkippedChannel[];
  error: string | null;
};
export type TBridgeServerStatus = {
  /** The bridge plugin is loaded; the section is offered only then. */
  available: boolean;
  configured: boolean;
  connected: boolean;
  botUser: { id: string; name: string } | null;
  lastError: string | null;
  link: TBridgeServerLinkView | null;
  remoteGuildName: string | null;
  counts: {
    /** Server-linked channels with a live webhook. */
    paired: number;
    excluded: number;
    /** Channels linked on their own, before or beside the server link. */
    manual: number;
  };
  sync: {
    running: boolean;
    last: TBridgeSyncReport | null;
  };
};

// -------------------- public directory --------------------
/** How the Directory orders its cards; the default is `online`. */
export type TDirectorySort = 'online' | 'members' | 'name';
/**
 * One Directory card. A local row carries `serverId` and `joined` for
 * the Discover-style preview/join; a federated row (from
 * directory_cache) carries its instance and the `fetchedAt` the card
 * shows as staleness. `logo` is a bare /public/ file name for a local
 * row and an absolute URL on the peer for a federated one.
 */
export type TDirectoryEntry = {
  source: 'local' | 'federated';
  serverId: number | null;
  publicId: string;
  name: string;
  description: string | null;
  tags: string[];
  game: string | null;
  memberCount: number;
  onlineCount: number;
  logo: string | null;
  hasPassword: boolean;
  joined: boolean;
  instance: { id: number; domain: string; name: string } | null;
  fetchedAt: number | null;
};

// ── Polls, scheduled posts, announcement follows (v0.4.0 / F6) ──────────

export type TPollOptionView = {
  key: string;
  label: string;
  votes: number;
  /**
   * Who chose this option — empty on an anonymous poll, and capped at
   * POLL_VOTER_LIST_CAP ids on a busy one (the count is still exact).
   */
  voterIds: number[];
};

/** What every viewer of the channel gets: counts, never the viewer's own choice. */
export type TPollUpdate = {
  id: number;
  messageId: number;
  channelId: number;
  question: string;
  options: TPollOptionView[];
  multiple: boolean;
  anonymous: boolean;
  closesAt: number | null;
  closedAt: number | null;
  createdBy: number | null;
  createdAt: number;
  /** Distinct voters (a multiple-choice voter counts once). */
  totalVoters: number;
};

/** `polls.get` and the vote routes: the update plus the caller's own choices. */
export type TPollView = TPollUpdate & { ownVotes: string[] };

export type TScheduledPostView = {
  id: number;
  channelId: number;
  userId: number;
  content: string;
  sendAt: number;
  createdAt: number;
  files: { id: number; name: string; originalName: string; size: number }[];
};

export type TFollowEndpoint =
  | {
      kind: 'local';
      channelId: number;
      channelName: string;
      serverId: number;
      serverName: string;
    }
  | {
      kind: 'remote';
      domain: string;
      channelPublicId: string;
      /** Known once the peer confirmed the follow (or named its follower channel). */
      channelName: string | null;
      serverName: string | null;
    };

export type TChannelFollowView = {
  id: number;
  createdAt: number;
  source: TFollowEndpoint;
  target: TFollowEndpoint;
};

/** An announcement channel the caller may follow from another channel. */
export type TFollowSourceCandidate = {
  serverId: number;
  serverName: string;
  channelId: number;
  channelName: string;
};

/**
 * The JSON body of an announcement copy — a `type: 'system'` row in a
 * follower channel. `sourceKey` identifies the source message across
 * instances (`local:<channelId>:<messageId>` or
 * `<domain>:<channelPublicId>:<messageId>`) so edits and deletions find
 * the copy and a replayed relay lands on the same row.
 */
export type TAnnouncementRow = {
  kind: 'announcement';
  sourceKey: string;
  source: {
    domain: string | null;
    serverPublicId: string;
    serverName: string;
    channelPublicId: string;
    channelName: string;
  };
  messageId: number;
  content: string;
  author: { publicId: string; name: string; avatarUrl: string | null };
  edited: boolean;
};

/**
 * What a deletion leaves behind on a message or DM message row (see
 * messages.deletedAt in db/schema.ts). Carried by MESSAGE_DELETE,
 * MESSAGE_BULK_DELETE and DM_MESSAGE_DELETE so the client marks the row
 * in place; `deletedBy` is null when no local account did it.
 */
export type TMessageTombstone = {
  deletedAt: number;
  deletedBy: number | null;
};

/**
 * A soundboard clip as members see it: the row plus the file it plays
 * (served by name from /public, inline as audio). `createdBy` is null
 * once the uploader's account is gone.
 */
export type TJoinedServerSound = TServerSound & {
  file: TFileRef;
};

/**
 * Fan-out of one soundboard trigger to the voice room (VOICE_SOUND_PLAY).
 * Carries everything a client needs to play the clip without a lookup:
 * the session may be hosted on a server the client is not looking at.
 */
export type TSoundPlayEvent = {
  channelId: number;
  soundId: number;
  userId: number;
  name: string;
  emoji: string | null;
  volume: number;
  file: TFileRef;
};

/**
 * One row of the Home overview's "Upcoming events": a scheduled event
 * of a community the caller belongs to, with the community named so the
 * row can open its tab, and the caller's own standing on the roster.
 */
export type TUpcomingEvent = {
  serverId: number;
  serverPublicId: string;
  serverName: string;
  event: Pick<TEvent, 'id' | 'title' | 'startsAt' | 'endsAt' | 'status' | 'hostId'>;
  mySignupStatus: TEventSignupStatus | null;
  /** Label of the role the caller holds (confirmed or benched); null otherwise. */
  mySignupRole: string | null;
};
