/**
 * Phase D / D0 — signed federation response unit tests.
 *
 * Covers `signFederationResponse` + `verifyFederationResponse`. These
 * extend the F1 challenge protocol to the response direction so
 * federation routes that return security-sensitive data (Phase D1
 * pre-key bundles, etc.) can authenticate the responder beyond TLS.
 *
 * The HTTP-level helper `queryInstance` and `signedJsonResponse` are
 * thin wrappers over these primitives — exercising the wrappers
 * directly would require mocking `federationFetch` and an HTTP
 * server, which is beyond the value of a unit test. The verification
 * primitive is what we care about; if it's correct the wrappers are
 * just plumbing.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  _resetSeenJtis,
  generateFederationKeys,
  getLocalKeys,
  signFederationResponse,
  verifyFederationResponse
} from '../federation';

const LOCAL_DOMAIN = 'test.local';
const PEER_DOMAIN = 'peer.example';

beforeEach(async () => {
  // setup.ts's beforeEach already TRUNCATEs federation_keys (and every
  // other table), so we don't need to DELETE it again here. Skipping
  // the redundant DELETE matters: parallel test files all running
  // their own redundant DELETE on the same shared CI database widen
  // the deadlock window with anything else taking AccessShareLocks
  // on adjacent tables.
  await initTest();
  await generateFederationKeys();
  _resetSeenJtis();
});

afterEach(() => {
  _resetSeenJtis();
});

describe('signFederationResponse shape', () => {
  test('embeds fromDomain and signature in the wire body', async () => {
    const payload = { bundleVersion: 1, identityKey: 'aGVsbG8=' };
    const body = await signFederationResponse(payload, LOCAL_DOMAIN);

    expect(body.fromDomain).toBe(LOCAL_DOMAIN);
    expect(typeof body.signature).toBe('string');
    expect(body.bundleVersion).toBe(1);
    expect(body.identityKey).toBe('aGVsbG8=');
  });
});

describe('signFederationResponse / verifyFederationResponse round-trip', () => {
  test('valid round-trip returns the payload without the signature field', async () => {
    // Self-loop: responder is LOCAL signing for LOCAL (same as the
    // challenge round-trip test), since the verifier enforces
    // aud === config.federation.domain (LOCAL_DOMAIN under the test
    // mock).
    const payload = { foo: 'bar', count: 7 };
    const body = await signFederationResponse(payload, LOCAL_DOMAIN);

    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const verified = await verifyFederationResponse(
      body,
      LOCAL_DOMAIN,
      publicKeyStr
    );

    expect(verified).not.toBeNull();
    expect(verified!.foo).toBe('bar');
    expect(verified!.count).toBe(7);
    expect(verified!.fromDomain).toBe(LOCAL_DOMAIN);
    expect(verified!.signature).toBeUndefined();
  });
});

describe('verifyFederationResponse rejection paths', () => {
  test('rejects when signature field is missing', async () => {
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const ok = await verifyFederationResponse(
      { foo: 'bar', fromDomain: LOCAL_DOMAIN },
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(ok).toBeNull();
  });

  test('rejects when signature is not a string', async () => {
    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const ok = await verifyFederationResponse(
      { foo: 'bar', fromDomain: LOCAL_DOMAIN, signature: 12345 },
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(ok).toBeNull();
  });

  test('rejects when payload is mutated after signing', async () => {
    const original = { value: 'original' };
    const body = await signFederationResponse(original, LOCAL_DOMAIN);

    const tampered = { ...body, value: 'tampered' };

    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const ok = await verifyFederationResponse(
      tampered,
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(ok).toBeNull();
  });

  test('rejects when expectedPeerDomain does not match the signer', async () => {
    const body = await signFederationResponse({ foo: 'bar' }, LOCAL_DOMAIN);

    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    // Body was signed by LOCAL_DOMAIN; we expect it from PEER_DOMAIN.
    const ok = await verifyFederationResponse(
      body,
      PEER_DOMAIN,
      publicKeyStr
    );
    expect(ok).toBeNull();
  });

  test('rejects when verified with an unrelated public key', async () => {
    const body = await signFederationResponse({ foo: 'bar' }, LOCAL_DOMAIN);

    // Replace the keypair so the stored pubkey no longer matches the
    // signing key. (The body was signed before the rotation.)
    const tdb = getTestDb();
    await tdb.execute(sql`DELETE FROM federation_keys`);
    await generateFederationKeys();
    const otherKeys = await getLocalKeys();
    const otherPublicKeyStr = JSON.stringify(otherKeys!.publicKey);

    const ok = await verifyFederationResponse(
      body,
      LOCAL_DOMAIN,
      otherPublicKeyStr
    );
    expect(ok).toBeNull();
  });

  test('rejects audience-mismatch — response signed for a different requester', async () => {
    // Sign for an audience that isn't us. verifyChallenge enforces
    // aud === config.federation.domain (LOCAL_DOMAIN here), so a
    // response captured while in flight to peer X cannot be replayed
    // against us.
    const body = await signFederationResponse(
      { foo: 'bar' },
      'someone-else.example'
    );

    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const ok = await verifyFederationResponse(
      body,
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(ok).toBeNull();
  });

  test('rejects on replay (same response body twice)', async () => {
    // Each signed response carries a fresh jti. If the same response
    // body arrives twice the second verification should reject.
    const body = await signFederationResponse({ foo: 'bar' }, LOCAL_DOMAIN);

    const keys = await getLocalKeys();
    const publicKeyStr = JSON.stringify(keys!.publicKey);

    const first = await verifyFederationResponse(
      body,
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(first).not.toBeNull();

    const second = await verifyFederationResponse(
      body,
      LOCAL_DOMAIN,
      publicKeyStr
    );
    expect(second).toBeNull();
  });
});
