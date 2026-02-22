import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetAll,
  checkPasswordRateLimit,
  recordPasswordFailure,
  recordPasswordSuccess
} from '../password-rate-limit';

afterEach(() => {
  _resetAll();
});

describe('password rate limiting', () => {
  test('allows first 3 attempts', () => {
    expect(checkPasswordRateLimit(1, 1).allowed).toBe(true);

    recordPasswordFailure(1, 1);
    expect(checkPasswordRateLimit(1, 1).allowed).toBe(true);

    recordPasswordFailure(1, 1);
    expect(checkPasswordRateLimit(1, 1).allowed).toBe(true);
  });

  test('locks out after 3 failures within 1 minute', () => {
    recordPasswordFailure(1, 1);
    recordPasswordFailure(1, 1);
    const result = recordPasswordFailure(1, 1);

    expect(result.lockedOut).toBe(true);
    expect(result.retryAfterMs).toBe(5 * 60_000);

    const check = checkPasswordRateLimit(1, 1);
    expect(check.allowed).toBe(false);
    expect(check.retryAfterMs).toBeGreaterThan(0);
  });

  test('tracks per-server independently', () => {
    // Lock out user 1 on server 1
    recordPasswordFailure(1, 1);
    recordPasswordFailure(1, 1);
    recordPasswordFailure(1, 1);

    expect(checkPasswordRateLimit(1, 1).allowed).toBe(false);
    // Same user, different server — should still be allowed
    expect(checkPasswordRateLimit(1, 2).allowed).toBe(true);
  });

  test('tracks per-user independently', () => {
    // Lock out user 1 on server 1
    recordPasswordFailure(1, 1);
    recordPasswordFailure(1, 1);
    recordPasswordFailure(1, 1);

    expect(checkPasswordRateLimit(1, 1).allowed).toBe(false);
    // Different user, same server — should still be allowed
    expect(checkPasswordRateLimit(2, 1).allowed).toBe(true);
  });

  test('resets on success', () => {
    recordPasswordFailure(1, 1);
    recordPasswordFailure(1, 1);

    // Success should clear the record
    recordPasswordSuccess(1, 1);

    // Should be allowed again and counter reset
    expect(checkPasswordRateLimit(1, 1).allowed).toBe(true);

    // Should need 3 more failures to lock out again
    recordPasswordFailure(1, 1);
    recordPasswordFailure(1, 1);
    expect(checkPasswordRateLimit(1, 1).allowed).toBe(true);
  });

  test('works with string serverId (handshake)', () => {
    recordPasswordFailure(1, 'handshake');
    recordPasswordFailure(1, 'handshake');
    recordPasswordFailure(1, 'handshake');

    expect(checkPasswordRateLimit(1, 'handshake').allowed).toBe(false);
    // Numeric server should be unaffected
    expect(checkPasswordRateLimit(1, 1).allowed).toBe(true);
  });
});
