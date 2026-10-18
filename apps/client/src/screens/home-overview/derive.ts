import { groupMembersByGame, type TPlayingGroup } from '@/helpers/game-presence';
import { getDisplayName } from '@/helpers/get-display-name';
import { stripToPlainText } from '@/helpers/strip-to-plain-text';
import type {
  TJoinedDmChannel,
  TJoinedPublicUser,
  TUpcomingEvent
} from '@pulse/server/types';
import { UserStatus } from '@pulse/shared';
import { addDays, format, isSameDay } from 'date-fns';

/**
 * Pure derivations behind the Home overview. Everything here takes the
 * state the client already holds (DM list, friends, roster, the
 * upcoming-events list) plus an injected `now`, so the screen renders
 * from one tick and the rules are testable without React.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SNIPPET_MAX = 80;

// ─── Conversations ────────────────────────────────────────────────────

/** What the DM actions leave in place of text they could not decrypt. */
const UNREADABLE = new Set(['[Encrypted message]', '[Unable to decrypt]']);

export type TConversationSnippet = {
  /** `encrypted` = an E2EE message this device cannot read (the lock placeholder). */
  kind: 'text' | 'deleted' | 'encrypted' | 'none';
  text: string;
  /** The last message was the viewer's own. */
  fromMe: boolean;
  /** The conversation is end-to-end encrypted (a decrypted text keeps the lock mark). */
  e2ee: boolean;
};

export type TRecentConversation = {
  id: number;
  name: string;
  isGroup: boolean;
  /** The other person of a 1:1 conversation. */
  peerId?: number;
  members: TJoinedPublicUser[];
  icon: TJoinedDmChannel['icon'];
  /** When the conversation last moved (its last message, else the channel itself). */
  at: number;
  unread: number;
  snippet: TConversationSnippet;
};

export const conversationSnippet = (
  channel: Pick<TJoinedDmChannel, 'lastMessage' | 'e2ee'>,
  ownUserId: number | undefined
): TConversationSnippet => {
  const last = channel.lastMessage;
  const e2ee = Boolean(channel.e2ee || last?.e2ee);
  if (!last) return { kind: 'none', text: 'No messages yet', fromMe: false, e2ee };
  const fromMe = ownUserId !== undefined && last.userId === ownUserId;
  if (last.deletedAt != null) {
    return { kind: 'deleted', text: 'Message deleted', fromMe, e2ee };
  }
  const content = last.content ?? '';
  if (e2ee && (content === '' || UNREADABLE.has(content))) {
    return { kind: 'encrypted', text: 'Encrypted message', fromMe, e2ee };
  }
  const text = stripToPlainText(content);
  if (text === '') {
    // An attachment-only message has no text to quote.
    return { kind: 'text', text: 'Attachment', fromMe, e2ee };
  }
  return { kind: 'text', text: text.slice(0, SNIPPET_MAX), fromMe, e2ee };
};

const conversationName = (
  channel: TJoinedDmChannel,
  others: TJoinedPublicUser[]
): string => {
  if (channel.isGroup) {
    return (
      channel.name || others.map((m) => getDisplayName(m)).join(', ') || 'Group'
    );
  }
  return others[0] ? getDisplayName(others[0]) : 'Conversation';
};

/**
 * The conversations that moved most recently, newest first, at most
 * `limit`. A conversation with nobody else in it (a left group) is not
 * listed.
 */
export const deriveRecentConversations = (
  channels: readonly TJoinedDmChannel[],
  ownUserId: number | undefined,
  limit = 8
): TRecentConversation[] =>
  channels
    .map((channel): TRecentConversation | null => {
      const others = channel.members.filter((m) => m.id !== ownUserId);
      if (others.length === 0) return null;
      return {
        id: channel.id,
        name: conversationName(channel, others),
        isGroup: channel.isGroup,
        peerId: channel.isGroup ? undefined : others[0]?.id,
        members: others,
        icon: channel.icon,
        at:
          channel.lastMessage?.createdAt ??
          channel.updatedAt ??
          channel.createdAt,
        unread: channel.unreadCount ?? 0,
        snippet: conversationSnippet(channel, ownUserId)
      };
    })
    .filter((row): row is TRecentConversation => row !== null)
    .sort((a, b) => b.at - a.at || b.id - a.id)
    .slice(0, limit);

/** "now", "5 min", "3 h", "2 d", then the date ("12 Oct"). */
export const formatRelativeAge = (at: number, now: number): string => {
  const diff = Math.max(0, now - at);
  if (diff < MINUTE_MS) return 'now';
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} min`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} h`;
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} d`;
  return format(at, 'd MMM');
};

// ─── Friends ──────────────────────────────────────────────────────────

const PRESENCE_RANK: Partial<Record<UserStatus, number>> = {
  [UserStatus.ONLINE]: 0,
  [UserStatus.IDLE]: 1,
  [UserStatus.DND]: 2
};

/** Present = any status the roster shows as a dot other than offline. */
export const isPresent = (user: Pick<TJoinedPublicUser, 'status'>): boolean =>
  PRESENCE_RANK[user.status ?? UserStatus.OFFLINE] !== undefined;

export type TFriendsForHome = {
  /** Present friends first (online, idle, busy), then by display name. */
  shown: TJoinedPublicUser[];
  onlineCount: number;
  total: number;
};

export const deriveFriendsForHome = (
  friends: readonly TJoinedPublicUser[],
  limit = 8
): TFriendsForHome => {
  const rank = (u: TJoinedPublicUser) =>
    PRESENCE_RANK[u.status ?? UserStatus.OFFLINE] ?? 3;
  const sorted = [...friends].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      getDisplayName(a).localeCompare(getDisplayName(b), undefined, {
        sensitivity: 'base'
      })
  );
  return {
    shown: sorted.slice(0, limit),
    onlineCount: friends.filter(isPresent).length,
    total: friends.length
  };
};

// ─── Upcoming events ──────────────────────────────────────────────────

export type TUpcomingDay = {
  /** Local midnight of the day, epoch ms. */
  dayStart: number;
  label: string;
  items: TUpcomingEvent[];
};

const dayLabel = (startsAt: number, now: number): string => {
  const date = new Date(startsAt);
  if (isSameDay(date, now)) return 'Today';
  if (isSameDay(date, addDays(now, 1))) return 'Tomorrow';
  return format(date, 'EEEE d MMM');
};

/** The rows in their order, grouped under the local day they start on. */
export const groupUpcomingByDay = (
  items: readonly TUpcomingEvent[],
  now: number
): TUpcomingDay[] => {
  const days: TUpcomingDay[] = [];
  for (const item of items) {
    const date = new Date(item.event.startsAt);
    const dayStart = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    ).getTime();
    const last = days[days.length - 1];
    if (last && last.dayStart === dayStart) {
      last.items.push(item);
    } else {
      days.push({ dayStart, label: dayLabel(item.event.startsAt, now), items: [item] });
    }
  }
  return days;
};

/** "in 12 min", "in 2 h", "in 2 h 30 min", "in 3 days"; "Starting now" once the start has passed. */
export const formatStartsIn = (startsAt: number, now: number): string => {
  const diff = startsAt - now;
  if (diff <= 0) return 'Starting now';
  if (diff < HOUR_MS) return `in ${Math.max(1, Math.floor(diff / MINUTE_MS))} min`;
  if (diff < DAY_MS) {
    const hours = Math.floor(diff / HOUR_MS);
    const minutes = Math.floor((diff % HOUR_MS) / MINUTE_MS);
    return minutes === 0 ? `in ${hours} h` : `in ${hours} h ${minutes} min`;
  }
  const days = Math.floor(diff / DAY_MS);
  return `in ${days} day${days === 1 ? '' : 's'}`;
};

/** An event starting within the hour is the one warm thing on the screen. */
export const startsSoon = (startsAt: number, now: number): boolean =>
  startsAt - now < HOUR_MS;

export const signupLabel = (
  item: Pick<TUpcomingEvent, 'mySignupStatus' | 'mySignupRole'>
): string => {
  switch (item.mySignupStatus) {
    case 'confirmed':
      return item.mySignupRole ? `Going as ${item.mySignupRole}` : 'Going';
    case 'bench':
      return item.mySignupRole
        ? `On the bench for ${item.mySignupRole}`
        : 'On the bench';
    case 'declined':
      return 'Declined';
    default:
      return 'Not signed up';
  }
};

// ─── Now playing ──────────────────────────────────────────────────────

/**
 * Friends and co-members by the game they play, through the roster
 * helper. The roster carries the presence (it is the one projection
 * that does), so a person on both lists is taken from it; the viewer's
 * own game is the greeting's line, not a group here.
 */
export const nowPlayingGroups = (
  roster: readonly TJoinedPublicUser[],
  friends: readonly TJoinedPublicUser[],
  ownUserId: number | undefined
): TPlayingGroup[] => {
  const byId = new Map<number, TJoinedPublicUser>();
  for (const user of roster) if (user.id !== ownUserId) byId.set(user.id, user);
  for (const user of friends) {
    if (user.id !== ownUserId && !byId.has(user.id)) byId.set(user.id, user);
  }
  return groupMembersByGame([...byId.values()]);
};
