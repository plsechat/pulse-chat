import { describe, expect, test } from 'bun:test';
import { getTokenExpiryMs, isTokenExpiringWithin } from '../token-expiry';

/** An unsigned JWT-shaped string with the given payload. */
const tokenWith = (payload: object) => {
  const encode = (value: object) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
};

describe('getTokenExpiryMs', () => {
  test('reads exp (seconds) as epoch milliseconds', () => {
    expect(getTokenExpiryMs(tokenWith({ exp: 1_800_000_000 }))).toBe(
      1_800_000_000_000
    );
  });

  test('handles base64url payloads that need padding', () => {
    // Payload lengths that are not a multiple of 4 after encoding.
    for (const sub of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
      expect(getTokenExpiryMs(tokenWith({ sub, exp: 1_700_000_000 }))).toBe(
        1_700_000_000_000
      );
    }
  });

  test('is null for anything that is not a JWT with a numeric exp', () => {
    expect(getTokenExpiryMs('')).toBeNull();
    expect(getTokenExpiryMs('opaque-supabase-token')).toBeNull();
    expect(getTokenExpiryMs('a.b')).toBeNull();
    expect(getTokenExpiryMs('a.!!!.c')).toBeNull();
    expect(getTokenExpiryMs(tokenWith({ sub: 'x' }))).toBeNull();
    expect(getTokenExpiryMs(tokenWith({ exp: '123' }))).toBeNull();
  });
});

describe('isTokenExpiringWithin', () => {
  const now = 1_700_000_000_000;
  const expIn = (seconds: number) => tokenWith({ exp: now / 1000 + seconds });

  test('is false while the token has more than the window left', () => {
    expect(isTokenExpiringWithin(expIn(15 * 60), 60_000, now)).toBe(false);
    expect(isTokenExpiringWithin(expIn(61), 60_000, now)).toBe(false);
  });

  test('is true inside the window and once expired', () => {
    expect(isTokenExpiringWithin(expIn(60), 60_000, now)).toBe(true);
    expect(isTokenExpiringWithin(expIn(5), 60_000, now)).toBe(true);
    expect(isTokenExpiringWithin(expIn(0), 60_000, now)).toBe(true);
    expect(isTokenExpiringWithin(expIn(-3600), 60_000, now)).toBe(true);
  });

  test('an unreadable token is never reported as expiring', () => {
    expect(isTokenExpiringWithin('opaque-supabase-token', 60_000, now)).toBe(
      false
    );
    expect(isTokenExpiringWithin(tokenWith({ sub: 'x' }), 60_000, now)).toBe(
      false
    );
  });

  test('defaults to the current clock', () => {
    expect(isTokenExpiringWithin(tokenWith({ exp: 1 }), 60_000)).toBe(true);
    expect(
      isTokenExpiringWithin(
        tokenWith({ exp: Math.floor(Date.now() / 1000) + 3600 }),
        60_000
      )
    ).toBe(false);
  });
});
