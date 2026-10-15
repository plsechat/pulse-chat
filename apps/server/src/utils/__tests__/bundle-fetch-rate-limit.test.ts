/**
 * Phase D / D1 — per-publicId pre-key bundle fetch rate limit unit
 * tests. Mirrors `federation-rate-limit.test.ts` but bound to a smaller
 * (10-token) capacity since legitimate cross-instance bundle fetches
 * per publicId are expected to be one-shot per session.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetBundleFetchRateLimit,
  _tryConsumeBundleFetchToken
} from '../bundle-fetch-rate-limit';

afterEach(() => {
  _resetBundleFetchRateLimit();
});

describe('bundle fetch rate limit (D1)', () => {
  test('allows the first 10 requests in a burst', () => {
    for (let i = 0; i < 10; i++) {
      expect(_tryConsumeBundleFetchToken('pub-alice')).toBe(true);
    }
  });

  test('rejects the 11th burst request', () => {
    for (let i = 0; i < 10; i++) {
      _tryConsumeBundleFetchToken('pub-alice');
    }
    expect(_tryConsumeBundleFetchToken('pub-alice')).toBe(false);
  });

  test('different publicIds have independent buckets', () => {
    for (let i = 0; i < 10; i++) {
      _tryConsumeBundleFetchToken('pub-alice');
    }
    expect(_tryConsumeBundleFetchToken('pub-alice')).toBe(false);
    // Bob's bucket is untouched — drains for one user mustn't drain
    // anyone else's pool. This is the load-bearing property of the
    // per-publicId scoping: a hostile peer enumerating Alice can't
    // also lock out Bob.
    expect(_tryConsumeBundleFetchToken('pub-bob')).toBe(true);
  });

  test('reset clears the bucket', () => {
    for (let i = 0; i < 10; i++) {
      _tryConsumeBundleFetchToken('pub-alice');
    }
    expect(_tryConsumeBundleFetchToken('pub-alice')).toBe(false);
    _resetBundleFetchRateLimit();
    expect(_tryConsumeBundleFetchToken('pub-alice')).toBe(true);
  });

  test('refills tokens over time at 10/min sustained', () => {
    // Drive the limiter's clock explicitly instead of sleeping: the
    // refill math is what's under test, not the wall clock.
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 10; i++) {
      _tryConsumeBundleFetchToken('pub-alice', t0);
    }
    expect(_tryConsumeBundleFetchToken('pub-alice', t0)).toBe(false);

    // 10/min = 1 token per 6 seconds. Just short of that, still empty.
    expect(_tryConsumeBundleFetchToken('pub-alice', t0 + 5_999)).toBe(false);

    // Past the 6 s mark a single token has refilled — one request goes
    // through, the next is refused again.
    expect(_tryConsumeBundleFetchToken('pub-alice', t0 + 7_000)).toBe(true);
    expect(_tryConsumeBundleFetchToken('pub-alice', t0 + 7_000)).toBe(false);

    // A full minute of idleness refills the whole burst, capped at 10.
    expect(_tryConsumeBundleFetchToken('pub-alice', t0 + 120_000)).toBe(true);
    for (let i = 0; i < 9; i++) {
      expect(_tryConsumeBundleFetchToken('pub-alice', t0 + 120_000)).toBe(true);
    }
    expect(_tryConsumeBundleFetchToken('pub-alice', t0 + 120_000)).toBe(false);
  });
});
