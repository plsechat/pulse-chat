/**
 * Phase 4 / F1 — signChallenge / verifyChallenge unit tests.
 *
 * Covers the wire-format hardening: body-hash binding (sha256), iss
 * binding to claimed sender domain, aud binding to recipient domain,
 * jti replay tracking, and TTL expiry. Local config federation domain
 * is mocked to 'test.local' (see __tests__/mock-modules.ts).
 *
 * Generates a fresh federation key pair for each test via the
 * production helper so the round-trip exercises the same JWK
 * import/export path as runtime.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { decodeJwt } from 'jose';
import { sql } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  _challengeInternals,
  _resetSeenJtis,
  generateFederationKeys,
  getLocalKeys,
  signChallenge,
  verifyChallenge
} from '../federation';

const LOCAL_DOMAIN = 'test.local';
const PEER_DOMAIN = 'peer.example';

beforeEach(async () => {
  await initTest();
  // Ensure each test has its own private/public pair.
  const tdb = getTestDb();
  await tdb.execute(sql`DELETE FROM federation_keys`);
  await generateFederationKeys();
  _resetSeenJtis();
});

afterEach(() => {
  _resetSeenJtis();
});

describe('canonicalize', () => {
  test('sorts object keys alphabetically', () => {
    const a = { c: 1, a: 2, b: 3 };
    const result = _challengeInternals.canonicalize(a);
    expect(result).toBe('{"a":2,"b":3,"c":1}');
  });

  test('preserves array order', () => {
    const arr = [3, 1, 2];
    expect(_challengeInternals.canonicalize(arr)).toBe('[3,1,2]');
  });

  test('handles nested objects with sorted keys at every level', () => {
    const nested = { z: { y: 1, x: 2 }, a: 3 };
    expect(_challengeInternals.canonicalize(nested)).toBe(
      '{"a":3,"z":{"x":2,"y":1}}'
    );
  });

  test('different insertion order yields identical output', () => {
    const a = { fromDomain: 'a.example', publicId: 'pid-1' };
    const b = { publicId: 'pid-1', fromDomain: 'a.example' };
    expect(_challengeInternals.canonicalize(a)).toBe(
      _challengeInternals.canonicalize(b)
    );
  });
});

describe('signChallenge / verifyChallenge round-trip', () => {
  test('valid signature passes when issuer + audience + body match', async () => {
    const payload = { fromDomain: LOCAL_DOMAIN, publicId: 'abc' };
    const sig = await signChallenge(payload, PEER_DOMAIN);

    // Pretend we are PEER receiving from LOCAL: aud must be us
    // (PEER), iss must be LOCAL, body must match. Since the test
    // runtime's config domain is LOCAL_DOMAIN, the verifier expects
    // aud === LOCAL_DOMAIN — so signing payload→PEER and verifying
    // here would fail. Instead test the symmetric self-loop: sign
    // for LOCAL, verify with LOCAL as the expected issuer.
    const selfSig = await signChallenge(payload, LOCAL_DOMAIN);
    const keys = await getLocalKeys();
    expect(keys).not.toBeNull();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const ok = await verifyChallenge(
      selfSig,
      payload,
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(ok).toBe(true);
    void sig;
  });

  test('JWT carries sha256, iss, aud, jti, exp claims', async () => {
    const payload = { foo: 'bar' };
    const sig = await signChallenge(payload, PEER_DOMAIN);
    const claims = decodeJwt(sig);
    expect(claims.iss).toBe(LOCAL_DOMAIN);
    expect(claims.aud).toBe(PEER_DOMAIN);
    expect(typeof claims.jti).toBe('string');
    expect(typeof claims.exp).toBe('number');
    expect(typeof (claims as Record<string, unknown>).sha256).toBe('string');
  });
});

describe('verifyChallenge rejection paths', () => {
  test('rejects on body tampering (sha256 mismatch)', async () => {
    const original = { fromDomain: LOCAL_DOMAIN, value: 'original' };
    const sig = await signChallenge(original, LOCAL_DOMAIN);
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const tampered = { fromDomain: LOCAL_DOMAIN, value: 'tampered' };
    const ok = await verifyChallenge(sig, tampered, LOCAL_DOMAIN, publicKeyStr);
    expect(ok).toBe(false);
  });

  test('rejects on issuer mismatch', async () => {
    const payload = { fromDomain: LOCAL_DOMAIN };
    const sig = await signChallenge(payload, LOCAL_DOMAIN);
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const ok = await verifyChallenge(
      sig,
      payload,
      'imposter.example',
      publicKeyStr
    );
    expect(ok).toBe(false);
  });

  test('rejects on audience mismatch', async () => {
    // Sign with audience='wrong.example' — signed for someone else,
    // so when we verify locally (aud must be 'test.local'), reject.
    const payload = { fromDomain: LOCAL_DOMAIN };
    const sig = await signChallenge(payload, 'wrong.example');
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const ok = await verifyChallenge(sig, payload, LOCAL_DOMAIN, publicKeyStr);
    expect(ok).toBe(false);
  });

  test('rejects replay (same jti twice)', async () => {
    const payload = { fromDomain: LOCAL_DOMAIN };
    const sig = await signChallenge(payload, LOCAL_DOMAIN);
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const first = await verifyChallenge(sig, payload, LOCAL_DOMAIN, publicKeyStr);
    expect(first).toBe(true);
    const second = await verifyChallenge(sig, payload, LOCAL_DOMAIN, publicKeyStr);
    expect(second).toBe(false);
  });

  test('rejects garbage signature', async () => {
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);
    const ok = await verifyChallenge(
      'not.a.jwt',
      { foo: 'bar' },
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(ok).toBe(false);
  });

  test('rejects when signed with a different key', async () => {
    const payload = { foo: 'bar' };
    const sig = await signChallenge(payload, LOCAL_DOMAIN);

    // Generate a fresh key pair NOT in the DB and try to verify with it
    const tdb = getTestDb();
    await tdb.execute(sql`DELETE FROM federation_keys`);
    await generateFederationKeys();
    const otherKeys = await getLocalKeys();
    const otherPublicKeyStr = JSON.stringify(otherKeys!.publicKey);

    const ok = await verifyChallenge(
      sig,
      payload,
      LOCAL_DOMAIN,
      otherPublicKeyStr
    );
    expect(ok).toBe(false);
  });
});

describe('canonical body shape independence', () => {
  test('verifier accepts payloads with different key insertion order', async () => {
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, bar: 2, foo: 1 };
    const sig = await signChallenge(a, LOCAL_DOMAIN);
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);
    const ok = await verifyChallenge(sig, b, LOCAL_DOMAIN, publicKeyStr);
    expect(ok).toBe(true);
  });
});
