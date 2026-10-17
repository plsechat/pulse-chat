/**
 * The slices of the Discord API objects the import reads. Field names
 * are the API's own (functional identifiers); anything not listed here
 * is ignored on the wire.
 */

type TDiscordUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

type TDiscordBotUser = TDiscordUser;

type TDiscordPartialGuild = {
  id: string;
  name: string;
  icon?: string | null;
  approximate_member_count?: number;
  approximate_presence_count?: number;
};

type TDiscordGuild = TDiscordPartialGuild & {
  description?: string | null;
  owner_id?: string;
};

type TDiscordOverwrite = {
  id: string;
  /** 0 = role, 1 = member */
  type: 0 | 1;
  allow: string;
  deny: string;
};

/** Channel `type` values the import understands. */
const DiscordChannelType = {
  GUILD_TEXT: 0,
  GUILD_VOICE: 2,
  GUILD_CATEGORY: 4,
  GUILD_ANNOUNCEMENT: 5,
  ANNOUNCEMENT_THREAD: 10,
  PUBLIC_THREAD: 11,
  PRIVATE_THREAD: 12,
  GUILD_STAGE_VOICE: 13,
  GUILD_FORUM: 15,
  GUILD_MEDIA: 16
} as const;

type TDiscordChannel = {
  id: string;
  type: number;
  name?: string;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  last_message_id?: string | null;
  permission_overwrites?: TDiscordOverwrite[];
  nsfw?: boolean;
};

type TDiscordThread = TDiscordChannel & {
  owner_id?: string;
  message_count?: number;
  thread_metadata?: {
    archived?: boolean;
    archive_timestamp?: string;
    auto_archive_duration?: number;
  };
};

type TDiscordRole = {
  id: string;
  name: string;
  color: number;
  position: number;
  /** Permission bit set as a decimal string. */
  permissions: string;
  managed?: boolean;
};

type TDiscordEmoji = {
  id: string | null;
  name: string | null;
  animated?: boolean;
  available?: boolean;
};

type TDiscordMember = {
  user?: TDiscordUser;
  nick?: string | null;
  roles: string[];
};

type TDiscordAttachment = {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
};

type TDiscordEmbed = {
  title?: string;
  url?: string;
  description?: string;
};

type TDiscordMessage = {
  id: string;
  type: number;
  content: string;
  author: TDiscordUser;
  timestamp: string;
  edited_timestamp?: string | null;
  pinned?: boolean;
  webhook_id?: string;
  attachments?: TDiscordAttachment[];
  embeds?: TDiscordEmbed[];
  mentions?: TDiscordUser[];
  mention_roles?: string[];
  mention_everyone?: boolean;
  message_reference?: { message_id?: string; channel_id?: string };
  sticker_items?: { id: string; name: string }[];
};

type TDiscordScheduledEvent = {
  id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  /** 1 scheduled, 2 active, 3 completed, 4 cancelled */
  status: number;
  creator_id?: string | null;
  entity_metadata?: { location?: string } | null;
};

type TDiscordActiveThreads = { threads: TDiscordThread[] };
type TDiscordArchivedThreads = { threads: TDiscordThread[]; has_more: boolean };

export { DiscordChannelType };
export type {
  TDiscordActiveThreads,
  TDiscordArchivedThreads,
  TDiscordAttachment,
  TDiscordBotUser,
  TDiscordChannel,
  TDiscordEmbed,
  TDiscordEmoji,
  TDiscordGuild,
  TDiscordMember,
  TDiscordMessage,
  TDiscordOverwrite,
  TDiscordPartialGuild,
  TDiscordRole,
  TDiscordScheduledEvent,
  TDiscordThread,
  TDiscordUser
};
