import { renderEmbedsAsText } from '@pulse/shared';
import type { TRemoteEmoji, TRemoteMember, TRemoteMessage, TRemoteUser } from './types';

/**
 * Pure mapping between the two message dialects. Nothing here touches
 * the network or the SDK, so every rule has a direct unit test.
 *
 * Inbound follows the community import's rules (the same service, the
 * same markup): mentions become `@name` / `@role` / `#channel` text,
 * custom emoji `:name:`, timestamps a date, embeds (title, description,
 * fields, footer — a status bot's whole card, through the helper the
 * import uses) and stickers extra lines. One deliberate difference
 * from the import: `@here` stays
 * `@here`. The import rewrote it to `@everyone` for history nobody is
 * paged about, but a live bridge posts through the SDK, which parses
 * `@everyone` into a real everyone-ping — a remote `@here` must not
 * page the whole community here.
 *
 * Outbound turns the composer's HTML (or its token form) into plain
 * text with the mention names resolved and never lets a ping through:
 * the webhook payload sets `allowed_mentions` to nothing, so an
 * `@everyone` typed here reads as text there.
 */

/** Our message cap. */
export const MAX_LOCAL_CONTENT = 16_000;
/** The remote service's message cap. */
export const MAX_REMOTE_CONTENT = 2_000;
export const MAX_AUTHOR_NAME = 80;
const MAX_QUOTE_LENGTH = 120;
/** Room an embed rendering may take under the local cap. */
const MAX_EMBED_TEXT = 4_000;

const CDN = 'https://cdn.discordapp.com';

export const boundText = (value: string | null | undefined, max: number, fallback = ''): string => {
  const trimmed = (value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  const bounded = Array.from(trimmed).slice(0, max).join('').trim();

  return bounded.length > 0 ? bounded : fallback;
};

// ─── remote → here ────────────────────────────────────────────────────

export type TInboundLookup = {
  roleName: (roleId: string) => string | undefined;
  channelName: (channelId: string) => string | undefined;
};

export const displayNameOf = (user: TRemoteUser, member?: TRemoteMember | null): string =>
  boundText(member?.nick || user.global_name || user.username, MAX_AUTHOR_NAME, 'Someone');

const isHash = (hash: string | null | undefined): hash is string =>
  typeof hash === 'string' && /^[a-z0-9_]+$/i.test(hash);

/** The member's server avatar when set, else the account avatar; animated ones as gif. */
export const avatarUrlOf = (
  user: TRemoteUser,
  member?: TRemoteMember | null,
  guildId?: string
): string | undefined => {
  if (guildId && isHash(member?.avatar)) {
    const hash = member.avatar;
    return `${CDN}/guilds/${guildId}/users/${user.id}/avatars/${hash}.${hash.startsWith('a_') ? 'gif' : 'png'}?size=128`;
  }

  if (isHash(user.avatar)) {
    return `${CDN}/avatars/${user.id}/${user.avatar}.${user.avatar.startsWith('a_') ? 'gif' : 'png'}?size=128`;
  }

  return undefined;
};

export const mapInboundContent = (message: TRemoteMessage, lookup: TInboundLookup): string => {
  const mentionNames = new Map(
    (message.mentions ?? []).map((u) => [u.id, u.global_name || u.username])
  );

  let content = (message.content ?? '')
    .replace(/<@!?(\d+)>/g, (_m, id: string) => `@${mentionNames.get(id) ?? 'someone'}`)
    .replace(/<@&(\d+)>/g, (_m, id: string) => `@${lookup.roleName(id) ?? 'role'}`)
    .replace(/<#(\d+)>/g, (_m, id: string) => `#${lookup.channelName(id) ?? 'channel'}`)
    .replace(/<a?:(\w+):(\d+)>/g, (_m, name: string) => `:${name}:`)
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_m, seconds: string) => {
      const ms = Number(seconds) * 1000;
      return Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) : '';
    });

  const extra: string[] = [];

  const embedText = renderEmbedsAsText(message.embeds, MAX_EMBED_TEXT, content);
  if (embedText.length > 0) extra.push(embedText);

  for (const sticker of message.sticker_items ?? []) {
    extra.push(`:${boundText(sticker.name, 64, 'sticker')}:`);
  }

  if (extra.length > 0) {
    content = content.length > 0 ? `${content}\n${extra.join('\n')}` : extra.join('\n');
  }

  return Array.from(content).slice(0, MAX_LOCAL_CONTENT).join('');
};

/** `{id: null, name: '👍'}` → `👍`; a custom emoji → `:name:` (our token form). */
export const mapInboundEmoji = (emoji: TRemoteEmoji): string | null => {
  if (!emoji.name) return null;
  return emoji.id ? `:${emoji.name}:` : emoji.name;
};

// ─── here → remote ────────────────────────────────────────────────────

export type TOutboundLookup = {
  userName: (userId: number) => string | undefined;
  roleName: (roleId: number) => string | undefined;
};

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' '
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (match) => ENTITIES[match] ?? match)
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point < 0x110000
        ? String.fromCodePoint(point)
        : '';
    });

const looksLikeHtml = (content: string): boolean =>
  content.startsWith('<p>') || /^<[a-z][\w-]*[\s>]/i.test(content);

/**
 * Composer HTML → text. Block ends become line breaks, list items a
 * dash, inline markup is dropped, entities decoded. A legacy mention
 * span already carries its label as text, so stripping the tag keeps
 * `@name`; the token form (`<@12>`) is resolved through the lookup.
 */
export const htmlToText = (content: string): string =>
  decodeEntities(
    content
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|blockquote|pre|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  );

export const mapOutboundContent = (content: string, lookup: TOutboundLookup): string => {
  // Tokens first: `<@8>` looks like a tag to the HTML stripper.
  const resolved = content
    .replace(/<@(\d+)>/g, (_m, id: string) => `@${lookup.userName(Number(id)) ?? 'member'}`)
    .replace(/<@&(\d+)>/g, (_m, id: string) => `@${lookup.roleName(Number(id)) ?? 'role'}`)
    .replace(/<:(\w+):\d+>/g, (_m, name: string) => `:${name}:`);

  const mapped = (looksLikeHtml(content) ? htmlToText(resolved) : resolved)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const chars = Array.from(mapped);
  return chars.length > MAX_REMOTE_CONTENT
    ? `${chars.slice(0, MAX_REMOTE_CONTENT - 1).join('')}…`
    : mapped;
};

/** `> @Author: first line` so a reply reads as one on the other side. */
export const quoteLine = (authorName: string, content: string): string => {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? '';
  return `> **${boundText(authorName, MAX_AUTHOR_NAME, 'Someone')}:** ${boundText(firstLine, MAX_QUOTE_LENGTH)}`;
};

/**
 * Our reaction token → the path segment the reactions endpoint takes:
 * a unicode emoji percent-encoded, a custom `:name:` as `name:id` when
 * the guild has one by that name (undefined otherwise — the remote
 * side has no such emoji, so there is nothing to mirror).
 */
export const mapOutboundEmoji = (
  emoji: string,
  customEmojiId: (name: string) => string | undefined
): string | undefined => {
  const custom = emoji.match(/^:(\w+):$/);

  if (custom) {
    const id = customEmojiId(custom[1]!);
    return id ? `${custom[1]}:${id}` : undefined;
  }

  return encodeURIComponent(emoji);
};
