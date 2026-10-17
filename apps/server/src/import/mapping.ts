import { ChannelType, MAX_MESSAGE_CONTENT_LENGTH, Permission } from '@pulse/shared';
import {
  DiscordChannelType,
  type TDiscordChannel,
  type TDiscordMember,
  type TDiscordMessage,
  type TDiscordRole
} from './discord/types';

/**
 * Pure mapping between the source service's objects and ours. Nothing
 * here touches the database or the network, so every rule has a direct
 * unit test: the permission table, channel kinds, colours, snowflake
 * arithmetic and the message-content rewrite.
 */

// ─── bounds (ours) ────────────────────────────────────────────────────

/** Same limits the routes enforce, so an imported row edits cleanly later. */
const BOUNDS = {
  serverName: 24,
  serverDescription: 128,
  categoryName: 32,
  channelName: 24,
  channelTopic: 128,
  threadName: 100,
  roleName: 24,
  userName: 32,
  emojiName: 24,
  eventTitle: 120,
  eventDescription: 2000
} as const;

const boundText = (value: string | null | undefined, max: number, fallback = ''): string => {
  const trimmed = (value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  const bounded = Array.from(trimmed).slice(0, max).join('').trim();

  return bounded.length > 0 ? bounded : fallback;
};

// ─── snowflakes ───────────────────────────────────────────────────────

const DISCORD_EPOCH_MS = 1_420_070_400_000n;

const snowflakeToTimestamp = (id: string): number => {
  if (!/^\d{1,20}$/.test(id)) return 0;

  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
};

/** The smallest id a message created at `timestampMs` could carry. */
const timestampToSnowflake = (timestampMs: number): string => {
  const since = BigInt(Math.max(0, Math.floor(timestampMs))) - DISCORD_EPOCH_MS;

  return ((since < 0n ? 0n : since) << 22n).toString();
};

const snowflakeMinusOne = (id: string): string => {
  const value = BigInt(id);

  return (value > 0n ? value - 1n : 0n).toString();
};

const compareSnowflakes = (a: string, b: string): number => {
  const x = BigInt(a);
  const y = BigInt(b);

  return x < y ? -1 : x > y ? 1 : 0;
};

// ─── permissions ──────────────────────────────────────────────────────

/**
 * Source permission bits → our Permission set, best effort. The source
 * model is finer-grained than ours (per-channel bits, audit log, voice
 * priority…); a bit with no counterpart grants nothing. ADMINISTRATOR
 * grants everything we have — a server admin there is one here.
 */
const DISCORD_PERMISSION_TABLE: { bit: bigint; name: string; grants: Permission[] }[] = [
  { bit: 1n << 0n, name: 'CREATE_INSTANT_INVITE', grants: [Permission.MANAGE_INVITES] },
  { bit: 1n << 1n, name: 'KICK_MEMBERS', grants: [Permission.MANAGE_USERS] },
  { bit: 1n << 2n, name: 'BAN_MEMBERS', grants: [Permission.MANAGE_USERS] },
  { bit: 1n << 3n, name: 'ADMINISTRATOR', grants: Object.values(Permission) },
  {
    bit: 1n << 4n,
    name: 'MANAGE_CHANNELS',
    grants: [
      Permission.MANAGE_CHANNELS,
      Permission.MANAGE_CATEGORIES,
      Permission.MANAGE_CHANNEL_PERMISSIONS
    ]
  },
  {
    bit: 1n << 5n,
    name: 'MANAGE_GUILD',
    grants: [Permission.MANAGE_SETTINGS, Permission.MANAGE_INVITES, Permission.MANAGE_AUTOMOD]
  },
  { bit: 1n << 6n, name: 'ADD_REACTIONS', grants: [Permission.REACT_TO_MESSAGES] },
  { bit: 1n << 9n, name: 'STREAM', grants: [Permission.SHARE_SCREEN] },
  { bit: 1n << 11n, name: 'SEND_MESSAGES', grants: [Permission.SEND_MESSAGES] },
  { bit: 1n << 13n, name: 'MANAGE_MESSAGES', grants: [Permission.MANAGE_MESSAGES, Permission.PIN_MESSAGES] },
  { bit: 1n << 15n, name: 'ATTACH_FILES', grants: [Permission.UPLOAD_FILES] },
  { bit: 1n << 20n, name: 'CONNECT', grants: [Permission.JOIN_VOICE_CHANNELS] },
  { bit: 1n << 28n, name: 'MANAGE_ROLES', grants: [Permission.MANAGE_ROLES] },
  { bit: 1n << 29n, name: 'MANAGE_WEBHOOKS', grants: [Permission.MANAGE_WEBHOOKS] },
  { bit: 1n << 30n, name: 'MANAGE_GUILD_EXPRESSIONS', grants: [Permission.MANAGE_EMOJIS] },
  { bit: 1n << 33n, name: 'MANAGE_EVENTS', grants: [Permission.MANAGE_EVENTS] },
  { bit: 1n << 40n, name: 'MODERATE_MEMBERS', grants: [Permission.MANAGE_USERS] },
  { bit: 1n << 51n, name: 'PIN_MESSAGES', grants: [Permission.PIN_MESSAGES] }
];

const ALL_BITS = (1n << 64n) - 1n;

const DISCORD_BIT = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  READ_MESSAGE_HISTORY: 1n << 16n
} as const;

/** The bot needs exactly these to read what the import copies. */
const IMPORT_BOT_PERMISSION_BITS = DISCORD_BIT.VIEW_CHANNEL | DISCORD_BIT.READ_MESSAGE_HISTORY;

const parseBits = (value: string | undefined | null): bigint => {
  if (!value || !/^\d{1,30}$/.test(value)) return 0n;

  return BigInt(value);
};

const mapPermissionBits = (bits: string): Permission[] => {
  const value = parseBits(bits);
  const granted = new Set<Permission>();

  for (const entry of DISCORD_PERMISSION_TABLE) {
    if ((value & entry.bit) === entry.bit) {
      for (const permission of entry.grants) granted.add(permission);
    }
  }

  // Stable order for tests and for the role_permissions rows.
  return Object.values(Permission).filter((p) => granted.has(p));
};

/**
 * The bot's effective bits in one channel, computed the way the source
 * documents it: @everyone's bits, OR the bot's roles, ADMINISTRATOR
 * short-circuits; then the channel overwrites (@everyone, roles deny
 * then allow, member deny then allow).
 */
const computeChannelPermissions = (
  guildId: string,
  roles: TDiscordRole[],
  botMember: TDiscordMember,
  botUserId: string,
  channel: TDiscordChannel
): bigint => {
  const byId = new Map(roles.map((r) => [r.id, r]));
  let base = parseBits(byId.get(guildId)?.permissions);

  for (const roleId of botMember.roles) {
    base |= parseBits(byId.get(roleId)?.permissions);
  }

  if ((base & DISCORD_BIT.ADMINISTRATOR) === DISCORD_BIT.ADMINISTRATOR) {
    return ALL_BITS;
  }

  const overwrites = channel.permission_overwrites ?? [];
  const everyone = overwrites.find((o) => o.id === guildId);
  let permissions = base;

  if (everyone) {
    permissions = (permissions & ~parseBits(everyone.deny)) | parseBits(everyone.allow);
  }

  let allow = 0n;
  let deny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type === 0 && botMember.roles.includes(overwrite.id)) {
      allow |= parseBits(overwrite.allow);
      deny |= parseBits(overwrite.deny);
    }
  }
  permissions = (permissions & ~deny) | allow;

  const member = overwrites.find((o) => o.type === 1 && o.id === botUserId);
  if (member) {
    permissions = (permissions & ~parseBits(member.deny)) | parseBits(member.allow);
  }

  return permissions;
};

const canReadHistory = (bits: bigint): boolean =>
  (bits & DISCORD_BIT.ADMINISTRATOR) === DISCORD_BIT.ADMINISTRATOR ||
  (bits & IMPORT_BOT_PERMISSION_BITS) === IMPORT_BOT_PERMISSION_BITS;

// ─── channels ─────────────────────────────────────────────────────────

/** Our kind for a source channel, or null when it has no counterpart. */
const mapChannelType = (type: number): ChannelType | null => {
  switch (type) {
    case DiscordChannelType.GUILD_TEXT:
    case DiscordChannelType.GUILD_ANNOUNCEMENT:
      return ChannelType.TEXT;
    case DiscordChannelType.GUILD_VOICE:
    case DiscordChannelType.GUILD_STAGE_VOICE:
      return ChannelType.VOICE;
    case DiscordChannelType.GUILD_FORUM:
    case DiscordChannelType.GUILD_MEDIA:
      return ChannelType.FORUM;
    default:
      return null;
  }
};

const isThreadType = (type: number): boolean =>
  type === DiscordChannelType.PUBLIC_THREAD ||
  type === DiscordChannelType.PRIVATE_THREAD ||
  type === DiscordChannelType.ANNOUNCEMENT_THREAD;

const byPosition = <T extends { position?: number; id: string }>(a: T, b: T): number =>
  (a.position ?? 0) - (b.position ?? 0) || compareSnowflakes(a.id, b.id);

// ─── colours & names ──────────────────────────────────────────────────

/** 0 means "no colour" there; our roles default to white. */
const colorIntToHex = (color: number | undefined): string => {
  if (!color || !Number.isInteger(color) || color < 0 || color > 0xffffff) {
    return '#ffffff';
  }

  return `#${color.toString(16).padStart(6, '0')}`;
};

const memberDisplayName = (user: { username: string; global_name?: string | null }, nick?: string | null) =>
  boundText(nick || user.global_name || user.username, BOUNDS.userName, 'Imported member');

// ─── assets ───────────────────────────────────────────────────────────

const CDN = 'https://cdn.discordapp.com';

const guildIconUrl = (guildId: string, hash: string | null | undefined): string | null =>
  hash && /^[a-z0-9_]+$/i.test(hash)
    ? `${CDN}/icons/${guildId}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=256`
    : null;

const userAvatarUrl = (userId: string, hash: string | null | undefined): string | null =>
  hash && /^[a-z0-9_]+$/i.test(hash)
    ? `${CDN}/avatars/${userId}/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=128`
    : null;

const emojiImageUrl = (emojiId: string, animated: boolean | undefined): string =>
  `${CDN}/emojis/${emojiId}.${animated ? 'gif' : 'png'}?size=128`;

// ─── message content ──────────────────────────────────────────────────

/** Message types that carry a member's own words; the rest are service notices. */
const IMPORTABLE_MESSAGE_TYPES = new Set([0, 19, 20, 23]);

type TContentLookup = {
  /** Source user id → our user id (already imported) */
  userId: (externalId: string) => number | undefined;
  /** Source role id → our role id */
  roleId: (externalId: string) => number | undefined;
  /** Source emoji id → our emoji {id, name} */
  emoji: (externalId: string) => { id: number; name: string } | undefined;
  /** Source channel id → its name (for `#channel` text) */
  channelName: (externalId: string) => string | undefined;
  roleName: (externalId: string) => string | undefined;
};

/**
 * Rewrite one message body into our token grammar. Mentions of
 * imported people and roles become live tokens, everything we cannot
 * resolve degrades to readable text instead of a bare id; custom
 * emoji become ours when the emoji was imported; embeds and stickers
 * become plain lines so nothing the author shared is lost.
 */
const mapMessageContent = (message: TDiscordMessage, lookup: TContentLookup): string => {
  const mentionNames = new Map(
    (message.mentions ?? []).map((u) => [u.id, u.global_name || u.username])
  );

  let content = (message.content ?? '')
    .replace(/<@!?(\d+)>/g, (_m, id: string) => {
      const ours = lookup.userId(id);
      return ours !== undefined ? `<@${ours}>` : `@${mentionNames.get(id) ?? 'someone'}`;
    })
    .replace(/<@&(\d+)>/g, (_m, id: string) => {
      const ours = lookup.roleId(id);
      return ours !== undefined ? `<@&${ours}>` : `@${lookup.roleName(id) ?? 'role'}`;
    })
    .replace(/<#(\d+)>/g, (_m, id: string) => `#${lookup.channelName(id) ?? 'channel'}`)
    .replace(/<a?:(\w+):(\d+)>/g, (_m, name: string, id: string) => {
      const ours = lookup.emoji(id);
      return ours ? `<:${ours.name}:${ours.id}>` : `:${name}:`;
    })
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_m, seconds: string) => {
      const ms = Number(seconds) * 1000;
      return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '';
    })
    .replace(/@here/g, '@everyone');

  const extra: string[] = [];

  for (const embed of message.embeds ?? []) {
    if (embed.url && !content.includes(embed.url)) {
      extra.push(embed.title ? `${boundText(embed.title, 200)} — ${embed.url}` : embed.url);
    }
  }

  for (const sticker of message.sticker_items ?? []) {
    extra.push(`:${boundText(sticker.name, 64, 'sticker')}:`);
  }

  if (extra.length > 0) {
    content = content.length > 0 ? `${content}\n${extra.join('\n')}` : extra.join('\n');
  }

  return Array.from(content).slice(0, MAX_MESSAGE_CONTENT_LENGTH).join('');
};

export type { TContentLookup };
export {
  BOUNDS,
  boundText,
  byPosition,
  canReadHistory,
  colorIntToHex,
  compareSnowflakes,
  computeChannelPermissions,
  DISCORD_PERMISSION_TABLE,
  emojiImageUrl,
  guildIconUrl,
  IMPORT_BOT_PERMISSION_BITS,
  IMPORTABLE_MESSAGE_TYPES,
  isThreadType,
  mapChannelType,
  mapMessageContent,
  mapPermissionBits,
  memberDisplayName,
  snowflakeMinusOne,
  snowflakeToTimestamp,
  timestampToSnowflake,
  userAvatarUrl
};
