/**
 * Schedule picker rules and the datetime-local round trip.
 *
 * Run via: bun test apps/client/src/features/scheduled/__tests__/validation.test.ts
 */
import { describe, expect, test } from 'bun:test';
import {
  defaultSendAt,
  fromLocalInputValue,
  toLocalInputValue,
  validateSendAt
} from '../validation';

const now = 1_760_000_000_000;

describe('validateSendAt', () => {
  test('window of 2 minutes to 30 days', () => {
    expect(validateSendAt(null, now)).toBe('Pick a date and time');
    expect(validateSendAt(Number.NaN, now)).toBe('Pick a date and time');
    expect(validateSendAt(now + 119_000, now)).toBe('Pick a time at least 2 minutes from now');
    expect(validateSendAt(now + 120_000, now)).toBeNull();
    expect(validateSendAt(now + 30 * 86_400_000, now)).toBeNull();
    expect(validateSendAt(now + 30 * 86_400_000 + 1, now)).toBe('Pick a time within the next 30 days');
  });
});

describe('defaultSendAt', () => {
  test('next quarter hour at least five minutes out', () => {
    const d = defaultSendAt(now);
    expect(d).toBeGreaterThanOrEqual(now + 5 * 60_000);
    expect(d % (15 * 60_000)).toBe(0);
    expect(d - now).toBeLessThan(20 * 60_000);
  });
});

describe('datetime-local round trip', () => {
  test('formats and parses in local time to the minute', () => {
    const ts = new Date(2026, 9, 16, 18, 5).getTime();
    expect(toLocalInputValue(ts)).toBe('2026-10-16T18:05');
    expect(fromLocalInputValue('2026-10-16T18:05')).toBe(ts);
    expect(fromLocalInputValue('')).toBeNull();
    expect(fromLocalInputValue('2026-10-16')).toBeNull();
    expect(fromLocalInputValue('garbage')).toBeNull();
  });
});
