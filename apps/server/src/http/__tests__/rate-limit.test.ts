import { afterEach, describe, expect, test } from 'bun:test';
import {
  _bucketCount,
  _resetAll,
  consumeRateLimit,
  MAX_BUCKETS,
  rateLimitKey,
  type RateLimitConfig
} from '../rate-limit-core';

// The HTTP wrapper (`http/rate-limit`) is replaced wholesale by the
// test preload so the suite's login-heavy tests never 429; the bucket
// logic under test lives in `rate-limit-core`, which is not mocked.

const authLike: RateLimitConfig = { windowMs: 15 * 60 * 1000, maxRequests: 10 };

const fakeReq = (url: string, ip = '203.0.113.7') => ({
  url,
  headers: {},
  socket: { remoteAddress: ip }
});

afterEach(() => {
  _resetAll();
});

describe('rate-limit key', () => {
  test('ignores the query string', () => {
    expect(rateLimitKey(fakeReq('/login?a=1'))).toBe('203.0.113.7:/login');
    expect(rateLimitKey(fakeReq('/login?a=2'))).toBe('203.0.113.7:/login');
    expect(rateLimitKey(fakeReq('/login'))).toBe('203.0.113.7:/login');
  });

  test('separates clients and paths', () => {
    expect(rateLimitKey(fakeReq('/login', '198.51.100.1'))).toBe(
      '198.51.100.1:/login'
    );
    expect(rateLimitKey(fakeReq('/register'))).toBe('203.0.113.7:/register');
  });

  test('11 hits to /login?a=N from one address → the 11th is refused', () => {
    for (let i = 1; i <= 10; i++) {
      const result = consumeRateLimit(rateLimitKey(fakeReq(`/login?a=${i}`)), authLike);
      expect(result.allowed).toBe(true);
    }

    const eleventh = consumeRateLimit(rateLimitKey(fakeReq('/login?a=11')), authLike);
    expect(eleventh.allowed).toBe(false);
    if (!eleventh.allowed) {
      expect(eleventh.retryAfterSec).toBeGreaterThan(0);
      expect(eleventh.retryAfterSec).toBeLessThanOrEqual(15 * 60);
    }

    expect(_bucketCount()).toBe(1);
  });
});

describe('rate-limit bucket map', () => {
  test('100k distinct query strings share one bucket', () => {
    for (let i = 0; i < 100_000; i++) {
      consumeRateLimit(rateLimitKey(fakeReq(`/auth/oidc/callback?code=${i}`)), authLike);
    }

    expect(_bucketCount()).toBe(1);
  });

  test('is capped at MAX_BUCKETS across distinct sources, evicting the oldest', () => {
    const total = MAX_BUCKETS + 10_000;

    for (let i = 0; i < total; i++) {
      consumeRateLimit(`src-${i}:/login`, authLike);
    }

    expect(_bucketCount()).toBe(MAX_BUCKETS);

    // The first keys were evicted; the newest survived with its count.
    const evictedAgain = consumeRateLimit('src-0:/login', authLike);
    expect(evictedAgain.allowed).toBe(true);

    for (let i = 0; i < 10; i++) {
      consumeRateLimit(`src-${total - 1}:/login`, authLike);
    }
    expect(consumeRateLimit(`src-${total - 1}:/login`, authLike).allowed).toBe(false);
  });

  test('a new window resets the count', () => {
    const tiny: RateLimitConfig = { windowMs: 1, maxRequests: 1 };

    expect(consumeRateLimit('k', tiny).allowed).toBe(true);
    expect(consumeRateLimit('k', tiny).allowed).toBe(false);

    const start = Date.now();
    while (Date.now() - start < 5) {
      // spin past the 1 ms window
    }

    expect(consumeRateLimit('k', tiny).allowed).toBe(true);
  });

  test('_resetAll drops every bucket', () => {
    consumeRateLimit('a', authLike);
    consumeRateLimit('b', authLike);
    expect(_bucketCount()).toBe(2);

    _resetAll();

    expect(_bucketCount()).toBe(0);
  });
});
