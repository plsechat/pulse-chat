import { ChannelPermission, type TFile, type TServer, type TSettings, type TUser } from ".";

export enum ChannelType {
  TEXT = "TEXT",
  VOICE = "VOICE",
  THREAD = "THREAD",
  FORUM = "FORUM",
}

export enum StreamKind {
  AUDIO = "audio",
  VIDEO = "video",
  SCREEN = "screen",
  SCREEN_AUDIO = "screen_audio",
  EXTERNAL_VIDEO = "external_video",
  EXTERNAL_AUDIO = "external_audio",
}

export type TExternalStreamTrackKind = "audio" | "video";

export type TExternalStreamTracks = {
  audio?: boolean;
  video?: boolean;
};

export type TRemoteProducerIds = {
  remoteVideoIds: number[];
  remoteAudioIds: number[];
  remoteScreenIds: number[];
  remoteScreenAudioIds: number[];
  remoteExternalStreamIds: number[];
};

export type TPublicServerSettings = Pick<
  TServer,
  | "id"
  | "name"
  | "description"
  | "publicId"
  | "storageUploadEnabled"
  | "storageQuota"
  | "storageUploadMaxFileSize"
  | "storageSpaceQuotaByUser"
  | "storageOverflowAction"
  | "enablePlugins"
>;

export type TGenericObject = {
  [key: string]: any;
};

export type TGenericFunction = {
  (...args: any[]): any;
};

export type TMessageMetadata = {
  url: string;
  title?: string;
  siteName?: string;
  description?: string;
  mediaType: string;
  images?: string[];
  videos?: string[];
  favicons?: string[];
};

export type WithOptional<T, K extends keyof T> = Omit<T, K> &
  Partial<Pick<T, K>>;

export enum UserStatus {
  ONLINE = "online",
  IDLE = "idle",
  DND = "dnd",
  INVISIBLE = "invisible",
  OFFLINE = "offline",
}

export type TOwnUser = TUser;

export type TConnectionParams = {
  accessToken: string;
  federationToken?: string;
};

export type TTempFile = {
  id: string;
  originalName: string;
  size: number;
  md5: string;
  path: string;
  extension: string;
  userId: number;
};

export type TServerInfo = Pick<
  TSettings,
  "serverId" | "name" | "description" | "allowNewUsers"
> & {
  id?: number;
  logo: TFile | null;
  version: string;
  registrationDisabled?: boolean;
  enabledAuthProviders?: string[];
  supabaseUrl: string;
  supabaseAnonKey: string;
  giphyApiKey?: string;
};

export type TArtifact = {
  name: string;
  target: string;
  size: number;
  checksum: string;
};

export type TVersionInfo = {
  version: string;
  releaseDate: string;
  artifacts: TArtifact[];
};

export type TIpInfo = {
  ip: string;
  hostname: string;
  city: string;
  region: string;
  country: string;
  loc: string;
  org: string;
  postal: string;
  timezone: string;
};

export type TChannelPermissionsMap = Record<ChannelPermission, boolean>;

export type TChannelUserPermissionsMap = Record<
  number,
  { channelId: number; permissions: TChannelPermissionsMap }
>;

export type TReadStateMap = Record<number, number>;

export type TLastReadMessageIdMap = Record<number, number | null>;

export type TMentionStateMap = Record<number, number>;

export type TThreadInfo = {
  id: number;
  name: string;
  messageCount: number;
  lastMessageAt: number | null;
  archived: boolean;
  parentChannelId: number;
  creatorId: number;
};

export enum NotificationLevel {
  ALL = 'all',
  MENTIONS = 'mentions',
  NOTHING = 'nothing',
  DEFAULT = 'default',
}

export const SLOW_MODE_OPTIONS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600] as const;

export const SLOW_MODE_LABELS: Record<number, string> = {
  0: 'Off',
  5: '5s',
  10: '10s',
  15: '15s',
  30: '30s',
  60: '1m',
  120: '2m',
  300: '5m',
  600: '10m',
  900: '15m',
  1800: '30m',
  3600: '1h',
  7200: '2h',
  21600: '6h',
};

export type TAutomodConfig = {
  keywords?: string[];
  regexPatterns?: string[];
  maxMentions?: number;
  allowedLinks?: string[];
  blockedLinks?: string[];
};

export type TAutomodAction = {
  type: 'delete_message' | 'alert_channel' | 'timeout_user' | 'log';
  channelId?: number;
  duration?: number;
};

export type TFederationInfo = {
  domain: string;
  name: string;
  version: string;
  publicKey: string;
  federationEnabled: boolean;
};

export type TFederationInstanceSummary = {
  id: number;
  domain: string;
  name: string | null;
  status: 'pending' | 'active' | 'blocked';
  direction: 'outgoing' | 'incoming' | 'mutual';
  lastSeenAt: number | null;
  createdAt: number;
};

export type TFederationConfig = {
  enabled: boolean;
  domain: string;
  hasKeys: boolean;
  publicKey?: string;
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

export enum AutomodRuleType {
  KEYWORD_FILTER = 'keyword_filter',
  SPAM_DETECTION = 'spam_detection',
  MENTION_SPAM = 'mention_spam',
  LINK_FILTER = 'link_filter',
}
