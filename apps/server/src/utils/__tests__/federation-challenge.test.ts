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

import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { decodeJwt, importJWK, SignJWT } from 'jose';
import { sql } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { federationSeenJti } from '../../db/schema';
import {
  _challengeInternals,
  _resetSeenJtis,
  generateFederationKeys,
  getLocalKeys,
  signChallenge,
  verifyChallenge,
  type LocalKeys
} from '../federation';

const LOCAL_DOMAIN = 'test.local';
const PEER_DOMAIN = 'peer.example';

// Called inside each DB-touching test, not from beforeEach: a file-level
// hook runs inside the same budget as the global TRUNCATE+seed and its
// inserts widen the deadlock window. The global reset already empties
// federation_keys, so generating a fresh pair per test is all that's
// needed for each test to own its private/public pair.
const setup = async () => {
  await initTest();
  await generateFederationKeys();
  _resetSeenJtis();
};

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
    await setup();
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
    await setup();
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
    await setup();
    const original = { fromDomain: LOCAL_DOMAIN, value: 'original' };
    const sig = await signChallenge(original, LOCAL_DOMAIN);
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const tampered = { fromDomain: LOCAL_DOMAIN, value: 'tampered' };
    const ok = await verifyChallenge(sig, tampered, LOCAL_DOMAIN, publicKeyStr);
    expect(ok).toBe(false);
  });

  test('rejects on issuer mismatch', async () => {
    await setup();
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
    await setup();
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
    await setup();
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
    await setup();
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
    await setup();
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

/** A challenge over `payload` with explicit timing, signed with `keys`. */
const challengeWith = async (
  keys: LocalKeys,
  payload: unknown,
  timing: { iat: number; exp: number }
): Promise<string> =>
  new SignJWT({ sha256: await _challengeInternals.payloadDigest(payload) })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(LOCAL_DOMAIN)
    .setAudience(LOCAL_DOMAIN)
    .setJti(randomUUIDv7())
    .setIssuedAt(timing.iat)
    .setExpirationTime(timing.exp)
    .sign(await importJWK(keys.privateKey, 'EdDSA'));

describe('clock tolerance', () => {
  test('a signature 30 s past its exp is accepted', async () => {
    await setup();
    const keys = (await getLocalKeys())!;
    const payload = { fromDomain: LOCAL_DOMAIN };
    const nowSec = Math.floor(Date.now() / 1000);
    const sig = await challengeWith(keys, payload, { iat: nowSec - 330, exp: nowSec - 30 });

    expect(
      await verifyChallenge(sig, payload, LOCAL_DOMAIN, JSON.stringify(keys.publicKey))
    ).toBe(true);
  });

  test('a signature 2 min past its exp is rejected', async () => {
    await setup();
    const keys = (await getLocalKeys())!;
    const payload = { fromDomain: LOCAL_DOMAIN };
    const nowSec = Math.floor(Date.now() / 1000);
    const sig = await challengeWith(keys, payload, { iat: nowSec - 420, exp: nowSec - 120 });

    expect(
      await verifyChallenge(sig, payload, LOCAL_DOMAIN, JSON.stringify(keys.publicKey))
    ).toBe(false);
  });
});

describe('replay protection survives a restart', () => {
  test('a jti is still rejected after the in-memory set is cleared', async () => {
    await setup();
    const payload = { fromDomain: LOCAL_DOMAIN };
    const sig = await signChallenge(payload, LOCAL_DOMAIN);
    const keys = (await getLocalKeys())!;
    const publicKeyStr = JSON.stringify(keys.publicKey);

    expect(await verifyChallenge(sig, payload, LOCAL_DOMAIN, publicKeyStr)).toBe(true);

    // The accepted jti is persisted with a retention past the exp.
    const { jti, exp } = decodeJwt(sig);
    const rows = await getTestDb()
      .select()
      .from(federationSeenJti);
    expect(rows.map((r) => r.jti)).toEqual([jti!]);
    expect(rows[0]!.expiresAt).toBe(exp! * 1000 + _challengeInternals.CLOCK_TOLERANCE_MS);

    // "Restart": the process-memory fast path is gone, the table decides.
    _resetSeenJtis();
    expect(await verifyChallenge(sig, payload, LOCAL_DOMAIN, publicKeyStr)).toBe(false);
  });

  test('a failed signature never consumes the jti', async () => {
    await setup();
    const payload = { fromDomain: LOCAL_DOMAIN };
    const sig = await signChallenge(payload, LOCAL_DOMAIN);
    const keys = (await getLocalKeys())!;
    const publicKeyStr = JSON.stringify(keys.publicKey);

    // Wrong body first (digest mismatch after a good signature check)…
    expect(
      await verifyChallenge(sig, { fromDomain: 'other' }, LOCAL_DOMAIN, publicKeyStr)
    ).toBe(false);
    expect(await getTestDb().select().from(federationSeenJti)).toHaveLength(0);

    // …then the genuine request still goes through once.
    expect(await verifyChallenge(sig, payload, LOCAL_DOMAIN, publicKeyStr)).toBe(true);
  });
});

describe('candidate key list (peer rotation grace)', () => {
  test('verifies against the previous key when the current one fails, in order', async () => {
    await setup();
    const payload = { fromDomain: LOCAL_DOMAIN };
    const sig = await signChallenge(payload, LOCAL_DOMAIN);
    const oldKeys = (await getLocalKeys())!;
    const oldPublic = JSON.stringify(oldKeys.publicKey);

    const tdb = getTestDb();
    await tdb.execute(sql`DELETE FROM federation_keys`);
    await generateFederationKeys();
    const newPublic = JSON.stringify((await getLocalKeys())!.publicKey);

    expect(await verifyChallenge(sig, payload, LOCAL_DOMAIN, [newPublic])).toBe(false);
    expect(await verifyChallenge(sig, payload, LOCAL_DOMAIN, [])).toBe(false);
    expect(await verifyChallenge(sig, payload, LOCAL_DOMAIN, [newPublic, oldPublic])).toBe(true);
  });
});

describe('canonical body shape independence', () => {
  test('verifier accepts payloads with different key insertion order', async () => {
    await setup();
    const a = { foo: 1, bar: 2, baz: 3 };
    const b = { baz: 3, bar: 2, foo: 1 };
    const sig = await signChallenge(a, LOCAL_DOMAIN);
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);
    const ok = await verifyChallenge(sig, b, LOCAL_DOMAIN, publicKeyStr);
    expect(ok).toBe(true);
  });
});
