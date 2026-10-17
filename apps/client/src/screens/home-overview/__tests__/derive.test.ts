/**
 * Home overview derivations: recent-conversation ordering and snippets
 * (tombstone, E2EE placeholder, own-message mark), friends ordering,
 * upcoming-events day grouping and wording, and the now-playing merge
 * of roster and friends through the shared grouping helper.
 *
 * Run via: bun test apps/client/src/screens/home-overview/__tests__/derive.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type {
  TJoinedDmChannel,
  TJoinedPublicUser,
  TUpcomingEvent
} from '@pulse/server/types';
import { UserStatus } from '@pulse/shared';
import {
  conversationSnippet,
  deriveFriendsForHome,
  deriveRecentConversations,
  formatRelativeAge,
  formatStartsIn,
  groupUpcomingByDay,
  nowPlayingGroups,
  signupLabel
} from '../derive';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// A fixed local noon so day labels do not depend on the zone the test runs in.
const NOW = new Date(2026, 9, 17, 12, 0, 0).getTime();

const user = (
  overrides: Partial<TJoinedPublicUser> & { id: number; name: string }
): TJoinedPublicUser =>
  ({
    publicId: `pid-${overrides.id}`,
    bannerColor: null,
    bio: null,
    pronouns: null,
    nameplate: null,
    avatarDecoration: null,
    nameStyle: null,
    customStatus: null,
    customStatusEmoji: null,
    avatar: null,
    avatarId: null,
    banner: null,
    bannerId: null,
    banned: false,
    deletedAt: null,
    createdAt: 0,
    roleIds: [],
    status: UserStatus.ONLINE,
    ...overrides
  }) as TJoinedPublicUser;

const ME = 1;
const bob = user({ id: 2, name: 'Bob' });
const cat = user({ id: 3, name: 'Cat' });

const message = (
  overrides: Partial<NonNullable<TJoinedDmChannel['lastMessage']>>
): NonNullable<TJoinedDmChannel['lastMessage']> =>
  ({
    id: 1,
    content: 'hello',
    e2ee: false,
    userId: bob.id,
    dmChannelId: 1,
    deletedAt: null,
    createdAt: NOW - HOUR,
    ...overrides
  }) as NonNullable<TJoinedDmChannel['lastMessage']>;

const channel = (
  overrides: Partial<TJoinedDmChannel> & { id: number }
): TJoinedDmChannel =>
  ({
    name: null,
    isGroup: false,
    e2ee: false,
    members: [user({ id: ME, name: 'Me' }), bob],
    lastMessage: message({}),
    unreadCount: 0,
    createdAt: NOW - 10 * DAY,
    updatedAt: null,
    ...overrides
  }) as TJoinedDmChannel;

describe('deriveRecentConversations', () => {
  test('orders by the last message, newest first, and caps the list', () => {
    const rows = deriveRecentConversations(
      [
        channel({ id: 1, lastMessage: message({ createdAt: NOW - 3 * HOUR }) }),
        channel({ id: 2, lastMessage: message({ createdAt: NOW - HOUR }) }),
        channel({ id: 3, lastMessage: null, updatedAt: NOW - 2 * HOUR }),
        channel({ id: 4, lastMessage: null, updatedAt: null, createdAt: NOW - 5 * DAY })
      ],
      ME,
      3
    );
    expect(rows.map((r) => r.id)).toEqual([2, 3, 1]);
    expect(rows[1]!.snippet).toMatchObject({ kind: 'none', text: 'No messages yet' });
  });

  test('names a 1:1 after the other person and a group after its name or members', () => {
    const rows = deriveRecentConversations(
      [
        channel({ id: 1, lastMessage: message({ createdAt: NOW - HOUR }) }),
        channel({
          id: 2,
          isGroup: true,
          members: [user({ id: ME, name: 'Me' }), bob, cat],
          lastMessage: message({ createdAt: NOW - 2 * HOUR })
        }),
        channel({
          id: 3,
          isGroup: true,
          name: 'Raid crew',
          members: [user({ id: ME, name: 'Me' }), bob, cat],
          lastMessage: message({ createdAt: NOW - 3 * HOUR })
        })
      ],
      ME
    );
    expect(rows.map((r) => r.name)).toEqual(['Bob', 'Bob, Cat', 'Raid crew']);
    expect(rows[0]!.peerId).toBe(bob.id);
    expect(rows[1]!.peerId).toBeUndefined();
  });

  test('a conversation with nobody else in it is not listed', () => {
    expect(
      deriveRecentConversations(
        [channel({ id: 1, isGroup: true, members: [user({ id: ME, name: 'Me' })] })],
        ME
      )
    ).toEqual([]);
  });

  test('carries the unread count', () => {
    const [row] = deriveRecentConversations([channel({ id: 1, unreadCount: 4 })], ME);
    expect(row!.unread).toBe(4);
  });
});

describe('conversationSnippet', () => {
  test('a deleted last message reads as the tombstone whoever sent it', () => {
    expect(
      conversationSnippet(
        { e2ee: false, lastMessage: message({ deletedAt: NOW, content: null }) },
        ME
      )
    ).toMatchObject({ kind: 'deleted', text: 'Message deleted' });
    expect(
      conversationSnippet(
        { e2ee: true, lastMessage: message({ deletedAt: NOW, content: null, e2ee: true }) },
        ME
      )
    ).toMatchObject({ kind: 'deleted', e2ee: true });
  });

  test('an unreadable encrypted message is the lock placeholder; a decrypted one keeps its text and the lock', () => {
    expect(
      conversationSnippet(
        { e2ee: true, lastMessage: message({ e2ee: true, content: '[Encrypted message]' }) },
        ME
      )
    ).toMatchObject({ kind: 'encrypted', text: 'Encrypted message', e2ee: true });
    expect(
      conversationSnippet(
        { e2ee: true, lastMessage: message({ e2ee: true, content: '' }) },
        ME
      )
    ).toMatchObject({ kind: 'encrypted' });
    expect(
      conversationSnippet(
        { e2ee: true, lastMessage: message({ e2ee: true, content: 'secret plan' }) },
        ME
      )
    ).toMatchObject({ kind: 'text', text: 'secret plan', e2ee: true });
  });

  test('plain text is stripped of markup, cut to length, and marked when it is mine', () => {
    const long = 'x'.repeat(120);
    expect(
      conversationSnippet(
        { e2ee: false, lastMessage: message({ content: `<p>${long}</p>`, userId: ME }) },
        ME
      )
    ).toMatchObject({ kind: 'text', text: 'x'.repeat(80), fromMe: true });
    expect(
      conversationSnippet({ e2ee: false, lastMessage: message({ content: '**hi** <@2>' }) }, ME)
    ).toMatchObject({ text: 'hi @user', fromMe: false });
  });

  test('an attachment-only message has a label instead of nothing', () => {
    expect(
      conversationSnippet({ e2ee: false, lastMessage: message({ content: '' }) }, ME)
    ).toMatchObject({ kind: 'text', text: 'Attachment' });
  });
});

describe('formatRelativeAge', () => {
  test('counts up through minutes, hours and days, then shows the date', () => {
    expect(formatRelativeAge(NOW - 10_000, NOW)).toBe('now');
    expect(formatRelativeAge(NOW - 5 * 60_000, NOW)).toBe('5 min');
    expect(formatRelativeAge(NOW - 3 * HOUR, NOW)).toBe('3 h');
    expect(formatRelativeAge(NOW - 2 * DAY, NOW)).toBe('2 d');
    expect(formatRelativeAge(NOW - 9 * DAY, NOW)).toBe('8 Oct');
    // A clock ahead of the server never reads negative.
    expect(formatRelativeAge(NOW + HOUR, NOW)).toBe('now');
  });
});

describe('deriveFriendsForHome', () => {
  test('present friends first (online, idle, busy), then by name; counts both', () => {
    const friends = [
      user({ id: 2, name: 'Zed', status: UserStatus.OFFLINE }),
      user({ id: 3, name: 'Amy', status: UserStatus.IDLE }),
      user({ id: 4, name: 'bea', status: UserStatus.ONLINE }),
      user({ id: 5, name: 'Cal', status: UserStatus.DND }),
      user({ id: 6, name: 'Abe', status: UserStatus.ONLINE }),
      user({ id: 7, name: 'Ivy', status: UserStatus.INVISIBLE })
    ];
    const { shown, onlineCount, total } = deriveFriendsForHome(friends, 4);
    expect(shown.map((f) => f.name)).toEqual(['Abe', 'bea', 'Amy', 'Cal']);
    expect(onlineCount).toBe(4);
    expect(total).toBe(6);
  });

  test('a nickname sorts as the shown name', () => {
    const { shown } = deriveFriendsForHome([
      user({ id: 2, name: 'Zed', nickname: 'Aardvark' }),
      user({ id: 3, name: 'Bob' })
    ]);
    expect(shown.map((f) => f.id)).toEqual([2, 3]);
  });
});

const upcoming = (
  id: number,
  startsIn: number,
  overrides: Partial<TUpcomingEvent> = {}
): TUpcomingEvent => ({
  serverId: 1,
  serverPublicId: 'srv',
  serverName: 'Guild',
  event: {
    id,
    title: `Event ${id}`,
    startsAt: NOW + startsIn,
    endsAt: NOW + startsIn + HOUR,
    status: 'scheduled',
    hostId: null
  },
  mySignupStatus: null,
  mySignupRole: null,
  ...overrides
});

describe('groupUpcomingByDay', () => {
  test('keeps the order and groups consecutive rows under Today, Tomorrow and the weekday', () => {
    const days = groupUpcomingByDay(
      [
        upcoming(1, HOUR),
        upcoming(2, 5 * HOUR),
        upcoming(3, DAY),
        upcoming(4, 3 * DAY)
      ],
      NOW
    );
    expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow', 'Tuesday 20 Oct']);
    expect(days.map((d) => d.items.map((i) => i.event.id))).toEqual([[1, 2], [3], [4]]);
  });

  test('an empty list has no days', () => {
    expect(groupUpcomingByDay([], NOW)).toEqual([]);
  });
});

describe('formatStartsIn / signupLabel', () => {
  test('wording by distance', () => {
    expect(formatStartsIn(NOW - 1, NOW)).toBe('Starting now');
    expect(formatStartsIn(NOW + 30_000, NOW)).toBe('in 1 min');
    expect(formatStartsIn(NOW + 12 * 60_000, NOW)).toBe('in 12 min');
    expect(formatStartsIn(NOW + 2 * HOUR, NOW)).toBe('in 2 h');
    expect(formatStartsIn(NOW + 2 * HOUR + 30 * 60_000, NOW)).toBe('in 2 h 30 min');
    expect(formatStartsIn(NOW + DAY, NOW)).toBe('in 1 day');
    expect(formatStartsIn(NOW + 3 * DAY + HOUR, NOW)).toBe('in 3 days');
  });

  test('signup wording', () => {
    expect(signupLabel({ mySignupStatus: null, mySignupRole: null })).toBe('Not signed up');
    expect(signupLabel({ mySignupStatus: 'confirmed', mySignupRole: 'Tank' })).toBe('Going as Tank');
    expect(signupLabel({ mySignupStatus: 'confirmed', mySignupRole: null })).toBe('Going');
    expect(signupLabel({ mySignupStatus: 'bench', mySignupRole: 'DPS' })).toBe('On the bench for DPS');
    expect(signupLabel({ mySignupStatus: 'bench', mySignupRole: null })).toBe('On the bench');
    expect(signupLabel({ mySignupStatus: 'declined', mySignupRole: null })).toBe('Declined');
  });
});

describe('nowPlayingGroups', () => {
  const game = (name: string) => ({ name, startedAt: NOW - HOUR });

  test('merges roster and friends, the roster copy winning, and leaves the viewer out', () => {
    const roster = [
      user({ id: ME, name: 'Me', gamePresence: game('Solo') }),
      user({ id: 2, name: 'Bob', gamePresence: game('Raid') }),
      user({ id: 3, name: 'Cat', gamePresence: game('Raid') })
    ];
    const friends = [
      // The friends mirror never carries presence; the roster copy is used.
      user({ id: 2, name: 'Bob' }),
      user({ id: 4, name: 'Dan', gamePresence: game('Chess') })
    ];
    const groups = nowPlayingGroups(roster, friends, ME);
    expect(groups.map((g) => [g.game, g.users.map((u) => u.name)])).toEqual([
      ['Raid', ['Bob', 'Cat']],
      ['Chess', ['Dan']]
    ]);
  });

  test('offline and not-playing people produce no group', () => {
    expect(
      nowPlayingGroups(
        [
          user({ id: 2, name: 'Bob' }),
          user({ id: 3, name: 'Cat', status: UserStatus.OFFLINE, gamePresence: game('Raid') })
        ],
        [],
        ME
      )
    ).toEqual([]);
  });
});
