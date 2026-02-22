import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  settings,
  servers,
  serverMembers,
  roles,
  categories,
  channels,
  files,
  users,
  logins,
  messages,
  messageFiles,
  rolePermissions,
  emojis,
  messageReactions,
  invites,
  activityLog,
  userRoles,
  channelRolePermissions,
  channelUserPermissions,
  channelReadStates,
  channelNotificationSettings,
  forumTags,
  forumPostTags,
  friendships,
  friendRequests,
  dmChannels,
  dmChannelMembers,
  dmMessages,
  dmMessageFiles,
  dmMessageReactions,
  dmReadStates,
  webhooks,
  automodRules,
  federationKeys,
  federationInstances,
  userIdentityKeys,
  userSignedPreKeys,
  userOneTimePreKeys,
  e2eeSenderKeys,
} from "../../../apps/server/src/db/schema";
import type { UserStatus } from "./types";
import type { Permission } from "./statics";

export type TSettings = InferSelectModel<typeof settings>;
export type TServer = InferSelectModel<typeof servers>;
export type TServerMember = InferSelectModel<typeof serverMembers>;
export type TRole = InferSelectModel<typeof roles>;
export type TCategory = InferSelectModel<typeof categories>;
export type TChannel = InferSelectModel<typeof channels>;
export type TFile = InferSelectModel<typeof files> & {
  _accessToken?: string;
};
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
export type TE2eeSenderKey = InferSelectModel<typeof e2eeSenderKeys>;

export type TStorageSettings = Pick<
  TSettings,
  | "storageUploadEnabled"
  | "storageQuota"
  | "storageUploadMaxFileSize"
  | "storageSpaceQuotaByUser"
  | "storageOverflowAction"
>;

// joined types

type TPublicUser = Pick<
  TJoinedUser,
  | "id"
  | "name"
  | "publicId"
  | "bannerColor"
  | "bio"
  | "avatar"
  | "avatarId"
  | "banner"
  | "bannerId"
  | "banned"
  | "createdAt"
> & {
  status?: UserStatus;
  _identity?: string;
};

export type TJoinedRole = TRole & {
  permissions: Permission[];
};

export type TJoinedMessageReaction = TMessageReaction & {
  file: TFile | null;
};

export type TMessageReplyPreview = {
  id: number;
  content: string | null;
  userId: number;
};

export type TJoinedMessage = TMessage & {
  files: TFile[];
  reactions: TJoinedMessageReaction[];
  replyTo?: TMessageReplyPreview | null;
};

export type TJoinedEmoji = TEmoji & {
  file: TFile;
  user: TPublicUser;
};

export type TJoinedUser = TUser & {
  avatar: TFile | null;
  banner: TFile | null;
  roleIds: number[];
};

export type TJoinedPublicUser = TPublicUser & {
  avatar: TFile | null;
  banner: TFile | null;
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
};

export type TJoinedDmMessage = TDmMessage & {
  files: TFile[];
  reactions: TJoinedDmMessageReaction[];
  replyTo?: TMessageReplyPreview | null;
};
