/**
 * Game-presence display helpers: the roster subline precedence (the
 * game wins over the custom status while set, the custom status comes
 * back when it clears), the "for N min" line, and the "Now playing"
 * grouping (by game, biggest group first, members by display name,
 * offline / banned / not-playing members left out).
 *
 * Run via: bun test apps/client/src/helpers/__tests__/game-presence.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TJoinedPublicUser } from '@pulse/server/types';
import { UserStatus } from '@pulse/shared';
import {
  formatPlayingFor,
  getRosterSubline,
  groupMembersByGame
} from '../game-presence';

const member = (
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

describe('getRosterSubline', () => {
  test('the game replaces the custom status while set', () => {
    expect(
      getRosterSubline({
        gamePresence: { name: 'Rocket Pass', startedAt: 0 },
        customStatus: 'working late'
      })
    ).toBe('Playing Rocket Pass');
  });

  test('the custom status returns once the game clears', () => {
    expect(getRosterSubline({ gamePresence: null, customStatus: 'working late' })).toBe(
      'working late'
    );
    expect(getRosterSubline({ customStatus: 'working late' })).toBe('working late');
  });

  test('nothing when neither is set', () => {
    expect(getRosterSubline({ gamePresence: null, customStatus: null })).toBeNull();
    expect(getRosterSubline({ customStatus: '' })).toBeNull();
  });
});

describe('formatPlayingFor', () => {
  const now = 1_700_000_000_000;

  test('reads in minutes under an hour, "just started" under a minute', () => {
    expect(formatPlayingFor(now - 30_000, now)).toBe('just started');
    expect(formatPlayingFor(now - 60_000, now)).toBe('for 1 min');
    expect(formatPlayingFor(now - 42 * 60_000, now)).toBe('for 42 min');
  });

  test('switches to hours with zero-padded minutes', () => {
    expect(formatPlayingFor(now - 60 * 60_000, now)).toBe('for 1 h 00 min');
    expect(formatPlayingFor(now - 125 * 60_000, now)).toBe('for 2 h 05 min');
  });

  test('a start in the future reads as just started', () => {
    expect(formatPlayingFor(now + 60_000, now)).toBe('just started');
  });
});

describe('groupMembersByGame', () => {
  test('groups players by game, biggest group first, members by display name', () => {
    const groups = groupMembersByGame([
      member({ id: 1, name: 'zed', gamePresence: { name: 'Chess', startedAt: 0 } }),
      member({ id: 2, name: 'amy', gamePresence: { name: 'Rocket Pass', startedAt: 0 } }),
      member({
        id: 3,
        name: 'bob',
        nickname: 'Alpha',
        gamePresence: { name: 'Rocket Pass', startedAt: 0 }
      }),
      member({ id: 4, name: 'cat', gamePresence: null }),
      member({ id: 5, name: 'dan' })
    ]);

    expect(groups.map((g) => g.game)).toEqual(['Rocket Pass', 'Chess']);
    // Display name (nickname first) orders the members.
    expect(groups[0]!.users.map((u) => u.id)).toEqual([3, 2]);
    expect(groups[1]!.users.map((u) => u.id)).toEqual([1]);
  });

  test('ties between equal groups break by game name', () => {
    const groups = groupMembersByGame([
      member({ id: 1, name: 'a', gamePresence: { name: 'Zebra Run', startedAt: 0 } }),
      member({ id: 2, name: 'b', gamePresence: { name: 'apple Quest', startedAt: 0 } })
    ]);
    expect(groups.map((g) => g.game)).toEqual(['apple Quest', 'Zebra Run']);
  });

  test('offline and banned members never form a group', () => {
    const groups = groupMembersByGame([
      member({
        id: 1,
        name: 'gone',
        status: UserStatus.OFFLINE,
        gamePresence: { name: 'Stale', startedAt: 0 }
      }),
      member({
        id: 2,
        name: 'nostatus',
        status: undefined,
        gamePresence: { name: 'Stale', startedAt: 0 }
      }),
      member({
        id: 3,
        name: 'banned',
        banned: true,
        gamePresence: { name: 'Stale', startedAt: 0 }
      })
    ]);
    expect(groups).toEqual([]);
  });

  test('an empty roster is an empty list', () => {
    expect(groupMembersByGame([])).toEqual([]);
  });
});
