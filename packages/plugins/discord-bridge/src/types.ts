/**
 * The slices of the remote service's API objects the bridge reads.
 * Field names are the API's own (functional identifiers); anything the
 * bridge does not use is left out so a payload change elsewhere cannot
 * break it.
 */

export type TRemoteUser = {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
};

export type TRemoteMember = {
  nick?: string | null;
  avatar?: string | null;
};

export type TRemoteAttachment = {
  id: string;
  filename: string;
  size: number;
  url: string;
  content_type?: string;
};

export type TRemoteEmbedMedia = {
  url?: string;
  proxy_url?: string;
  width?: number;
  height?: number;
  content_type?: string;
};

export type TRemoteEmbed = {
  /** rich, image, video, gifv, article, link … */
  type?: string;
  title?: string;
  url?: string;
  description?: string;
  fields?: { name?: string; value?: string; inline?: boolean }[];
  footer?: { text?: string; icon_url?: string } | null;
  image?: TRemoteEmbedMedia | null;
  thumbnail?: TRemoteEmbedMedia | null;
  video?: TRemoteEmbedMedia | null;
};

export type TRemoteStickerItem = {
  id: string;
  name: string;
};

export type TRemoteMessageReference = {
  message_id?: string;
  channel_id?: string;
};

export type TRemoteMessage = {
  id: string;
  channel_id: string;
  guild_id?: string;
  author?: TRemoteUser;
  member?: TRemoteMember;
  content?: string;
  type?: number;
  attachments?: TRemoteAttachment[];
  embeds?: TRemoteEmbed[];
  sticker_items?: TRemoteStickerItem[];
  mentions?: TRemoteUser[];
  message_reference?: TRemoteMessageReference;
  webhook_id?: string;
  edited_timestamp?: string | null;
};

export type TRemoteEmoji = {
  id: string | null;
  name: string | null;
  animated?: boolean;
};

export type TRemoteReactionEvent = {
  user_id: string;
  channel_id: string;
  message_id: string;
  guild_id?: string;
  emoji: TRemoteEmoji;
};

export type TRemoteChannel = {
  id: string;
  guild_id?: string;
  /** 0 text, 2 voice, 4 category, 5 announcement, 10/11/12 threads, 15 forum. */
  type: number;
  name?: string;
  parent_id?: string | null;
  position?: number;
  /** Threads only: whether this dispatch is the thread's creation. */
  newly_created?: boolean;
};

export type TRemoteRole = {
  id: string;
  name: string;
};

export type TRemoteGuildEmoji = {
  id: string | null;
  name: string | null;
  animated?: boolean;
};

export type TRemoteGuild = {
  id: string;
  name: string;
  icon?: string | null;
  roles?: TRemoteRole[];
  channels?: TRemoteChannel[];
  emojis?: TRemoteGuildEmoji[];
};

export type TRemoteWebhook = {
  id: string;
  token?: string;
  channel_id?: string;
};

export type TRemoteScheduledEvent = {
  id: string;
  guild_id: string;
  name: string;
  description?: string | null;
  scheduled_start_time: string;
  scheduled_end_time?: string | null;
  /** 1 scheduled, 2 active, 3 completed, 4 cancelled. */
  status?: number;
  creator_id?: string | null;
  entity_metadata?: { location?: string } | null;
};

export type TGatewayPayload = {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
};

export type TReadyPayload = {
  session_id: string;
  resume_gateway_url: string;
  user: TRemoteUser;
};
