import { afterEach, describe, expect, test } from 'bun:test';
import {
  _resetFederationRateLimit,
  _tryConsumeFederationToken
} from '../federation-fetch';

afterEach(() => {
  _resetFederationRateLimit();
});

describe('federation outbound rate limit (F6)', () => {
  test('allows the first 60 requests in a burst', () => {
    for (let i = 0; i < 60; i++) {
      expect(_tryConsumeFederationToken('peer.example.com')).toBe(true);
    }
  });

  test('rejects the 61st burst request', () => {
    for (let i = 0; i < 60; i++) {
      _tryConsumeFederationToken('peer.example.com');
    }
    expect(_tryConsumeFederationToken('peer.example.com')).toBe(false);
  });

  test('different hosts have independent buckets', () => {
    for (let i = 0; i < 60; i++) {
      _tryConsumeFederationToken('a.example.com');
    }
    expect(_tryConsumeFederationToken('a.example.com')).toBe(false);
    expect(_tryConsumeFederationToken('b.example.com')).toBe(true);
  });

  test('reset clears the bucket', () => {
    for (let i = 0; i < 60; i++) {
      _tryConsumeFederationToken('peer.example.com');
    }
    expect(_tryConsumeFederationToken('peer.example.com')).toBe(false);
    _resetFederationRateLimit();
    expect(_tryConsumeFederationToken('peer.example.com')).toBe(true);
  });

  test('refills tokens over time at 1/sec sustained', async () => {
    for (let i = 0; i < 60; i++) {
      _tryConsumeFederationToken('peer.example.com');
    }
    expect(_tryConsumeFederationToken('peer.example.com')).toBe(false);

    // 1.5 seconds → ~1 token refilled (60/min = 1/sec).
    await new Promise((r) => setTimeout(r, 1_500));

    expect(_tryConsumeFederationToken('peer.example.com')).toBe(true);
  });
});
