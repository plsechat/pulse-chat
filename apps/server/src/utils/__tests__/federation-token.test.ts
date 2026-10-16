/**
 * Federation token verification outcomes and local key selection.
 *
 * `verifyFederationTokenDetailed` tells an expired token apart from a
 * rejected one (the socket layer maps them to different close codes),
 * accepts a peer's previous key inside the rotation grace window, and
 * tolerates a minute of clock skew. `getLocalKeys` signs with the
 * newest live key after a rotation.
 *
 * Self-loop setup: the local instance is seeded as its own active peer
 * (config domain `test.local`), so a token minted here for `test.local`
 * verifies here. Setup is inline per test (no beforeEach).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, decodeProtectedHeader } from 'jose';
import { getTestDb } from '../../__tests__/mock-db';
import { initTest } from '../../__tests__/helpers';
import { federationInstances, federationKeys } from '../../db/schema';
import {
  _resetSeenJtis,
  FEDERATION_KEY_GRACE_MS,
  generateFederationKeys,
  generateFederationToken,
  getLocalKeys,
  getPeerVerificationKeys,
  peerVerificationKeys,
  rotateLocalFederationKeys,
  signChallenge,
  verifyFederationToken,
  verifyFederationTokenDetailed,
  type LocalKeys
} from '../federation';

const LOCAL_DOMAIN = 'test.local';
const HOUR_MS = 60 * 60 * 1000;

afterEach(() => {
  _resetSeenJtis();
});

const seedSelfAsPeer = async (publicKey: string): Promise<number> => {
  const [row] = await getTestDb()
    .insert(federationInstances)
    .values({
      domain: LOCAL_DOMAIN,
      name: 'self',
      status: 'active',
      direction: 'mutual',
      publicKey,
      createdAt: Date.now()
    })
    .returning({ id: federationInstances.id });
  return row!.id;
};

const setup = async (): Promise<{ keys: LocalKeys; instanceId: number }> => {
  await initTest();
  await generateFederationKeys();
  const keys = (await getLocalKeys())!;
  const instanceId = await seedSelfAsPeer(JSON.stringify(keys.publicKey));
  return { keys, instanceId };
};

/** A federation token with explicit timing, signed with `keys`. */
const tokenWith = async (
  keys: LocalKeys,
  opts: { exp: number; iat?: number; issuer?: string }
): Promise<string> =>
  new SignJWT({ sub: '1', name: 'alice', avatar: null, publicId: 'pid-1' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(opts.issuer ?? LOCAL_DOMAIN)
    .setAudience(LOCAL_DOMAIN)
    .setIssuedAt(opts.iat ?? opts.exp - 24 * 3600)
    .setExpirationTime(opts.exp)
    .sign(await importJWK(keys.privateKey, 'EdDSA'));

const nowSec = () => Math.floor(Date.now() / 1000);

describe('verifyFederationTokenDetailed', () => {
  test('a freshly minted token verifies with its claims', async () => {
    const { instanceId } = await setup();
    const token = await generateFederationToken(7, 'alice', LOCAL_DOMAIN, null, 'pid-7');

    const result = await verifyFederationTokenDetailed(token);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.userId).toBe(7);
    expect(result.username).toBe('alice');
    expect(result.publicId).toBe('pid-7');
    expect(result.issuerDomain).toBe(LOCAL_DOMAIN);
    expect(result.instanceId).toBe(instanceId);
  });

  test('an expired token is reported as expired, not rejected', async () => {
    const { keys } = await setup();
    const token = await tokenWith(keys, { exp: nowSec() - 120 });

    expect(await verifyFederationTokenDetailed(token)).toEqual({
      ok: false,
      reason: 'expired'
    });
    expect(await verifyFederationToken(token)).toBeNull();
  });

  test('a token 30 s past its exp is still accepted (clock tolerance)', async () => {
    const { keys } = await setup();
    const token = await tokenWith(keys, { exp: nowSec() - 30 });

    expect((await verifyFederationTokenDetailed(token)).ok).toBe(true);
  });

  test('an unknown issuer is rejected as invalid', async () => {
    const { keys } = await setup();
    const token = await tokenWith(keys, {
      exp: nowSec() + 3600,
      issuer: 'nobody.example'
    });

    expect(await verifyFederationTokenDetailed(token)).toEqual({
      ok: false,
      reason: 'invalid'
    });
  });

  test('a signature from an unpinned key is rejected as invalid', async () => {
    await setup();
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    const stranger: LocalKeys = {
      id: 0,
      privateKey: await exportJWK(privateKey),
      publicKey: await exportJWK(publicKey)
    };
    const token = await tokenWith(stranger, { exp: nowSec() + 3600 });

    expect(await verifyFederationTokenDetailed(token)).toEqual({
      ok: false,
      reason: 'invalid'
    });
    expect(await verifyFederationToken(token)).toBeNull();
  });

  test('a token signed with the peer previous key verifies inside the grace window', async () => {
    const { keys: oldKeys, instanceId } = await setup();
    const token = await tokenWith(oldKeys, { exp: nowSec() + 3600 });

    // The peer rotated: current pin is a new key, old key kept with a
    // fresh rotation stamp.
    const { publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    await getTestDb()
      .update(federationInstances)
      .set({
        publicKey: JSON.stringify(await exportJWK(publicKey)),
        previousPublicKey: JSON.stringify(oldKeys.publicKey),
        keyRotatedAt: Date.now() - HOUR_MS
      })
      .where(eq(federationInstances.id, instanceId));

    expect((await verifyFederationTokenDetailed(token)).ok).toBe(true);
    expect(await getPeerVerificationKeys(LOCAL_DOMAIN)).toHaveLength(2);
  });

  test('the previous key is refused once the grace window has passed', async () => {
    const { keys: oldKeys, instanceId } = await setup();
    const token = await tokenWith(oldKeys, { exp: nowSec() + 3600 });

    const { publicKey } = await generateKeyPair('EdDSA', { extractable: true });
    await getTestDb()
      .update(federationInstances)
      .set({
        publicKey: JSON.stringify(await exportJWK(publicKey)),
        previousPublicKey: JSON.stringify(oldKeys.publicKey),
        keyRotatedAt: Date.now() - FEDERATION_KEY_GRACE_MS - HOUR_MS
      })
      .where(eq(federationInstances.id, instanceId));

    expect(await verifyFederationTokenDetailed(token)).toEqual({
      ok: false,
      reason: 'invalid'
    });
    expect(await getPeerVerificationKeys(LOCAL_DOMAIN)).toHaveLength(1);
  });
});

describe('peerVerificationKeys', () => {
  test('current key first, previous only inside the grace window', () => {
    const now = 1_000_000_000_000;
    expect(
      peerVerificationKeys(
        { publicKey: 'cur', previousPublicKey: 'prev', keyRotatedAt: now - HOUR_MS },
        now
      )
    ).toEqual(['cur', 'prev']);
    expect(
      peerVerificationKeys(
        {
          publicKey: 'cur',
          previousPublicKey: 'prev',
          keyRotatedAt: now - FEDERATION_KEY_GRACE_MS
        },
        now
      )
    ).toEqual(['cur']);
    expect(
      peerVerificationKeys({ publicKey: 'cur', previousPublicKey: 'prev', keyRotatedAt: null }, now)
    ).toEqual(['cur']);
    expect(
      peerVerificationKeys({ publicKey: null, previousPublicKey: null, keyRotatedAt: null }, now)
    ).toEqual([]);
  });

  test('an inactive or unknown peer has no verification keys', async () => {
    const { instanceId } = await setup();
    await getTestDb()
      .update(federationInstances)
      .set({ status: 'blocked' })
      .where(eq(federationInstances.id, instanceId));

    expect(await getPeerVerificationKeys(LOCAL_DOMAIN)).toEqual([]);
    expect(await getPeerVerificationKeys('unknown.example')).toEqual([]);
  });
});

describe('local key selection', () => {
  test('getLocalKeys returns the newest live row and skips retired ones', async () => {
    await initTest();
    const first = await generateFederationKeys();
    const second = await generateFederationKeys();

    expect((await getLocalKeys())!.id).toBe(second.id);

    await getTestDb()
      .update(federationKeys)
      .set({ retiredAt: Date.now() })
      .where(eq(federationKeys.id, second.id));

    expect((await getLocalKeys())!.id).toBe(first.id);
  });

  test('rotateLocalFederationKeys retires the live key and signs with the new one', async () => {
    await initTest();
    await generateFederationKeys();
    const before = (await getLocalKeys())!;

    const { previous, next } = await rotateLocalFederationKeys();

    expect(previous.id).toBe(before.id);
    expect(next.id).not.toBe(before.id);
    expect((await getLocalKeys())!.id).toBe(next.id);

    const rows = await getTestDb().select().from(federationKeys);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === previous.id)!.retiredAt).not.toBeNull();
    expect(rows.find((r) => r.id === next.id)!.retiredAt).toBeNull();

    // A signature made now verifies with the NEW public key only.
    const sig = await signChallenge({ a: 1 }, 'peer.example');
    expect(decodeProtectedHeader(sig).alg).toBe('EdDSA');
    await expect(
      jwtVerify(sig, await importJWK(next.publicKey, 'EdDSA'), { audience: 'peer.example' })
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(sig, await importJWK(previous.publicKey, 'EdDSA'), { audience: 'peer.example' })
    ).rejects.toThrow();

    // An explicit pair overrides the live key (the rotation announcement).
    const oldSig = await signChallenge({ a: 1 }, 'peer.example', previous);
    await expect(
      jwtVerify(oldSig, await importJWK(previous.publicKey, 'EdDSA'), { audience: 'peer.example' })
    ).resolves.toBeDefined();
  });

  test('rotateLocalFederationKeys refuses when no key exists', async () => {
    await initTest();
    await expect(rotateLocalFederationKeys()).rejects.toThrow('Federation keys not generated');
  });
});
