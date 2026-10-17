/**
 * Calendar helpers: the month grid, local-day windows (local midnight,
 * not UTC), day membership of events and the relative wording.
 *
 * Run via: bun test apps/client/src/features/events/__tests__/calendar.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  combineDayAndTime,
  dayStartOf,
  eventTouchesDay,
  groupByStartDay,
  monthGridDays,
  monthStartOf,
  relativeTime,
  shiftMonth,
  timeInputValue,
  windowForAgenda,
  windowForDay,
  windowForMonth
} from '../calendar';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min, 0, 0).getTime();

describe('month grid', () => {
  test('October 2026 spans 5 full Monday-first weeks', () => {
    const days = monthGridDays(local(2026, 10, 1));
    expect(days.length % 7).toBe(0);
    expect(days.length).toBe(35);
    // Oct 1 2026 is a Thursday: the grid opens on Monday Sep 28.
    expect(new Date(days[0]!.start).getDay()).toBe(1);
    expect(days[0]!.dayOfMonth).toBe(28);
    expect(days[0]!.inMonth).toBe(false);
    expect(days[3]!.dayOfMonth).toBe(1);
    expect(days[3]!.inMonth).toBe(true);
    expect(days[days.length - 1]!.dayOfMonth).toBe(1);
    expect(days[days.length - 1]!.inMonth).toBe(false);
    expect(days.filter((d) => d.inMonth).length).toBe(31);
  });

  test('every square is exactly one local day, DST or not', () => {
    // March 2026 holds the EU/US spring-forward in zones that observe it;
    // a square must still end where the next one starts.
    const days = monthGridDays(local(2026, 3, 1));
    for (let i = 1; i < days.length; i++) {
      expect(days[i]!.start).toBe(days[i - 1]!.end);
      expect(new Date(days[i]!.start).getHours()).toBe(0);
    }
  });

  test('month helpers move by whole local months', () => {
    expect(monthStartOf(local(2026, 10, 16, 13, 37))).toBe(local(2026, 10, 1));
    expect(shiftMonth(local(2026, 12, 1), 1)).toBe(local(2027, 1, 1));
    expect(shiftMonth(local(2026, 1, 1), -1)).toBe(local(2025, 12, 1));
    expect(dayStartOf(local(2026, 10, 16, 23, 59))).toBe(local(2026, 10, 16));
  });
});

describe('windows', () => {
  test('the month window covers the grid, local boundaries inclusive', () => {
    const w = windowForMonth(local(2026, 10, 1));
    expect(w.from).toBe(local(2026, 9, 28));
    expect(w.to).toBe(local(2026, 11, 2) - 1);
  });

  test('a day window is [local midnight, next midnight)', () => {
    const w = windowForDay(local(2026, 10, 16));
    expect(w.from).toBe(local(2026, 10, 16));
    expect(w.to).toBe(local(2026, 10, 17) - 1);
  });

  test('the agenda runs 31 days from today', () => {
    const w = windowForAgenda(local(2026, 10, 16, 15));
    expect(w.from).toBe(local(2026, 10, 16));
    expect(w.to).toBe(local(2026, 11, 16) - 1);
  });

  test('never spans more than the server allows (62 days)', () => {
    for (const month of [1, 2, 3, 7, 12]) {
      const w = windowForMonth(local(2026, month, 1));
      expect(w.to - w.from).toBeLessThanOrEqual(62 * DAY);
    }
  });
});

describe('day membership', () => {
  const day = { start: local(2026, 10, 16), end: local(2026, 10, 17) };

  test('an event at 00:30 local belongs to that local day', () => {
    expect(
      eventTouchesDay(
        {
          startsAt: local(2026, 10, 16, 0, 30),
          endsAt: local(2026, 10, 16, 2)
        },
        day
      )
    ).toBe(true);
    expect(
      eventTouchesDay(
        { startsAt: local(2026, 10, 15, 22), endsAt: local(2026, 10, 16) },
        day
      )
    ).toBe(false);
  });

  test('an event over midnight touches both days', () => {
    const e = {
      startsAt: local(2026, 10, 16, 23),
      endsAt: local(2026, 10, 17, 1)
    };
    expect(eventTouchesDay(e, day)).toBe(true);
    expect(
      eventTouchesDay(e, {
        start: local(2026, 10, 17),
        end: local(2026, 10, 18)
      })
    ).toBe(true);
    expect(
      eventTouchesDay(e, {
        start: local(2026, 10, 18),
        end: local(2026, 10, 19)
      })
    ).toBe(false);
  });

  test('groupByStartDay lists an event once, under its first day, soonest first', () => {
    const groups = groupByStartDay([
      { id: 2, startsAt: local(2026, 10, 17, 20) },
      { id: 1, startsAt: local(2026, 10, 16, 23) },
      { id: 3, startsAt: local(2026, 10, 16, 9) }
    ]);
    expect(groups.map((g) => g.dayStart)).toEqual([
      local(2026, 10, 16),
      local(2026, 10, 17)
    ]);
    expect(groups[0]!.events.map((e) => e.id)).toEqual([3, 1]);
    expect(groups[1]!.events.map((e) => e.id)).toEqual([2]);
  });
});

describe('time helpers', () => {
  test('combine and format round-trip in local time', () => {
    const day = local(2026, 10, 16);
    expect(combineDayAndTime(day, '20:30')).toBe(local(2026, 10, 16, 20, 30));
    expect(timeInputValue(local(2026, 10, 16, 7, 5))).toBe('07:05');
    expect(timeInputValue(combineDayAndTime(day, '00:00'))).toBe('00:00');
  });

  test('relative wording', () => {
    const now = local(2026, 10, 16, 12);
    expect(relativeTime(now + 30_000, now)).toBe('now');
    expect(relativeTime(now + 35 * 60_000, now)).toBe('in 35 min');
    expect(relativeTime(now + 2 * HOUR, now)).toBe('in 2 h');
    expect(relativeTime(now + 90 * 60_000, now)).toBe('in 1.5 h');
    expect(relativeTime(now + 3 * DAY, now)).toBe('in 3 d');
    expect(relativeTime(now - 2 * HOUR, now)).toBe('2 h ago');
  });
});
