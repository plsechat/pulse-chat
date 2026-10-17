import { describe, expect, test } from 'bun:test';
import { groupTimestamp } from '../time-format';

const minutes = (n: number) => n * 60_000;

describe('groupTimestamp', () => {
  const now = new Date('2026-10-16T15:00:00');

  test('reads as a relative time inside the last hour', () => {
    expect(groupTimestamp(new Date(now.getTime() - minutes(0.5)), now)).toBe(
      'just now'
    );
    expect(groupTimestamp(new Date(now.getTime() - minutes(1)), now)).toBe(
      '1 min ago'
    );
    expect(groupTimestamp(new Date(now.getTime() - minutes(42)), now)).toBe(
      '42 min ago'
    );
  });

  test('falls back to the clock time for the rest of today, then day labels', () => {
    expect(
      groupTimestamp(new Date(now.getTime() - minutes(61)), now)
    ).toMatch(/^Today at /);
    expect(
      groupTimestamp(new Date('2026-10-15T09:00:00'), now)
    ).toMatch(/^Yesterday at /);
    expect(groupTimestamp(new Date('2026-10-01T09:00:00'), now)).toMatch(
      /^10\/01\/2026 /
    );
  });

  test('a timestamp from the future is not relative', () => {
    expect(
      groupTimestamp(new Date(now.getTime() + minutes(5)), now)
    ).toMatch(/^Today at /);
  });
});
