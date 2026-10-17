/**
 * Roster arithmetic: fill ratio, role order, bench ordering, the
 * attention rule for the Apps row, the calendar-URL prefix rule and the
 * reminder wording.
 *
 * Run via: bun test apps/client/src/features/events/__tests__/roster.test.ts
 */
import type { TEventListItem, TEventSignup } from '@pulse/server/types';
import { describe, expect, test } from 'bun:test';
import {
  eventNeedsAttention,
  fillOf,
  isSignedUp,
  orderBench,
  orderConfirmed,
  reminderKey,
  reminderText,
  resolveCalendarUrl,
  roleCountLabel,
  roleIsFull,
  roleLabel,
  roleOrder
} from '../roster';

const HOUR = 60 * 60 * 1000;
const roles = [
  { key: 'tank', label: 'Tank', cap: 2, color: '#60a5fa' },
  { key: 'healer', label: 'Healer', cap: 4, color: null },
  { key: 'dps', label: 'DPS', cap: 14, color: '#ff5c6c' }
];
const counts = {
  byRole: {
    tank: { confirmed: 2, bench: 1 },
    healer: { confirmed: 1, bench: 0 },
    dps: { confirmed: 5, bench: 0 }
  },
  confirmed: 8,
  bench: 1,
  declined: 2
};

describe('fillOf', () => {
  test('sums the role caps', () => {
    expect(fillOf(roles, counts, null)).toEqual({
      confirmed: 8,
      cap: 20,
      ratio: 0.4
    });
  });

  test('a tighter participant cap wins', () => {
    expect(fillOf(roles, counts, 10)).toEqual({
      confirmed: 8,
      cap: 10,
      ratio: 0.8
    });
    expect(fillOf(roles, counts, 30).cap).toBe(20);
  });

  test('an uncapped role makes the roster open-ended unless participants are capped', () => {
    const open = [
      ...roles,
      { key: 'flex', label: 'Flex', cap: null, color: null }
    ];
    expect(fillOf(open, counts, null)).toEqual({
      confirmed: 8,
      cap: null,
      ratio: null
    });
    expect(fillOf(open, counts, 16)).toEqual({
      confirmed: 8,
      cap: 16,
      ratio: 0.5
    });
  });

  test('ratio never exceeds 1', () => {
    expect(fillOf(roles, { confirmed: 25 }, null).ratio).toBe(1);
  });
});

describe('roles', () => {
  test('labels and fullness', () => {
    expect(roleCountLabel(roles[0]!, counts)).toBe('2/2');
    expect(
      roleCountLabel({ key: 'x', label: 'X', cap: null, color: null }, counts)
    ).toBe('0');
    expect(roleIsFull(roles[0]!, counts)).toBe(true);
    expect(roleIsFull(roles[2]!, counts)).toBe(false);
    expect(roleLabel(roles, 'dps')).toBe('DPS');
    // A removed role keeps its key visible rather than vanishing.
    expect(roleLabel(roles, 'gone')).toBe('gone');
  });

  test('role order is the event order, as a copy', () => {
    const ordered = roleOrder(roles);
    expect(ordered.map((r) => r.key)).toEqual(['tank', 'healer', 'dps']);
    expect(ordered).not.toBe(roles);
  });
});

describe('ordering', () => {
  const s = (id: number, position: number, createdAt: number): TEventSignup =>
    ({
      id,
      eventId: 1,
      userId: id,
      roleKey: 'dps',
      status: 'bench',
      position,
      createdAt
    }) as TEventSignup;

  test('bench = position, then the older signup, then id', () => {
    const bench = [s(3, 2, 30), s(1, 1, 10), s(2, 1, 5), s(4, 2, 30)];
    expect(orderBench(bench).map((x) => x.id)).toEqual([2, 1, 3, 4]);
    // Pure: the input is untouched.
    expect(bench.map((x) => x.id)).toEqual([3, 1, 2, 4]);
  });

  test('confirmed uses the same rule', () => {
    expect(orderConfirmed([s(2, 5, 1), s(1, 0, 9)]).map((x) => x.id)).toEqual([
      1, 2
    ]);
  });
});

describe('attention', () => {
  const now = 1_000 * HOUR;
  const item = (patch: Partial<TEventListItem>): TEventListItem =>
    ({
      id: 1,
      roles,
      counts,
      status: 'scheduled',
      startsAt: now + 30 * 60_000,
      endsAt: now + 3 * HOUR,
      ownSignup: { roleKey: 'dps', status: 'confirmed', position: 0 },
      ...patch
    }) as TEventListItem;

  test('signed up and starting within the hour', () => {
    expect(eventNeedsAttention(item({}), now)).toBe(true);
    expect(eventNeedsAttention(item({ startsAt: now + HOUR }), now)).toBe(true);
    expect(eventNeedsAttention(item({ startsAt: now + HOUR + 1 }), now)).toBe(
      false
    );
  });

  test('a benched signup counts; a declined or absent one does not', () => {
    expect(
      eventNeedsAttention(
        item({ ownSignup: { roleKey: 'dps', status: 'bench', position: 2 } }),
        now
      )
    ).toBe(true);
    expect(
      eventNeedsAttention(
        item({ ownSignup: { roleKey: '', status: 'declined', position: 0 } }),
        now
      )
    ).toBe(false);
    expect(eventNeedsAttention(item({ ownSignup: null }), now)).toBe(false);
    expect(isSignedUp(null)).toBe(false);
  });

  test('live events count; done, cancelled and already-ended ones do not', () => {
    expect(
      eventNeedsAttention(item({ status: 'live', startsAt: now - HOUR }), now)
    ).toBe(true);
    expect(eventNeedsAttention(item({ status: 'done' }), now)).toBe(false);
    expect(eventNeedsAttention(item({ status: 'cancelled' }), now)).toBe(false);
    expect(
      eventNeedsAttention(
        item({ startsAt: now - 5 * HOUR, endsAt: now - HOUR }),
        now
      )
    ).toBe(false);
  });
});

describe('calendar url', () => {
  test('prefixes the path with the origin when the server gave no absolute url', () => {
    expect(
      resolveCalendarUrl(
        {
          path: '/events/abc.ics?u=1&token=t',
          url: '/events/abc.ics?u=1&token=t'
        },
        'https://chat.example'
      )
    ).toBe('https://chat.example/events/abc.ics?u=1&token=t');
  });

  test('keeps an absolute url as given', () => {
    expect(
      resolveCalendarUrl(
        {
          path: '/events/abc.ics',
          url: 'https://public.example/events/abc.ics'
        },
        'https://chat.example'
      )
    ).toBe('https://public.example/events/abc.ics');
  });
});

describe('reminders', () => {
  test('wording per stage and a stable dedupe key', () => {
    expect(reminderText('Raid Night', 1)).toBe('Raid Night starts in 24 hours');
    expect(reminderText('Raid Night', 2)).toBe('Raid Night starts in 1 hour');
    expect(reminderText('Raid Night', 3)).toBe('Raid Night is starting now');
    expect(reminderKey({ serverId: 3, eventId: 9, stage: 2 })).toBe('3:9:2');
  });
});
