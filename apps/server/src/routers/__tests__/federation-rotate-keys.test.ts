/**
 * federation.rotateKeys — owner-only key rotation.
 *
 * Inserts a new signing key, retires the old one, and announces the
 * rotation to every ACTIVE peer at POST /federation/key-rotation,
 * signed with the OLD key (the only one the peer has pinned). A peer
 * that answers 404 predates the route and is reported as unsupported
 * instead of being retried.
 *
 * Fetch + DNS are spied via the shared fixtures and restored by
 * `mock.restore()`; setup is inline per test.
 */
import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { importJWK, jwtVerify } from 'jose';
import { config } from '../../config';
import {
  mockDns,
  seedPeerInstance,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { federationInstances, federationKeys } from '../../db/schema';
import { generateFederationKeys, getLocalKeys } from '../../utils/federation';
import { _resetFederationRateLimit } from '../../utils/federation-fetch';

const previousFederationEnabled = config.federation.enabled;
config.federation.enabled = true;

const PEER_A = 'peer-a.rotate.example.com';
const PEER_B = 'peer-b.rotate.example.com';
const PEER_PENDING = 'pending.rotate.example.com';

afterEach(() => {
  mock.restore();
  _resetFederationRateLimit();
});

afterAll(() => {
  config.federation.enabled = previousFederationEnabled;
});

const seedPendingPeer = async (domain: string) => {
  await getTestDb().insert(federationInstances).values({
    domain,
    name: domain,
    status: 'pending',
    direction: 'incoming',
    publicKey: '{"kty":"OKP","crv":"Ed25519","x":"placeholder"}',
    createdAt: Date.now()
  });
};

describe('federation.rotateKeys', () => {
  test('retires the live key, mints a new one and announces it to active peers under the old key', async () => {
    const { caller } = await initTest(1);
    await generateFederationKeys();
    const oldKeys = (await getLocalKeys())!;
    mockDns();
    await seedPeerInstance(PEER_A);
    await seedPeerInstance(PEER_B);
    await seedPendingPeer(PEER_PENDING);
    const { calls } = spyOnFetch();

    const result = await caller.federation.rotateKeys();

    // Key rows: old retired, new live, new is what we sign with now.
    const rows = await getTestDb().select().from(federationKeys);
    expect(rows).toHaveLength(2);
    const oldRow = rows.find((r) => r.id === oldKeys.id)!;
    const newRow = rows.find((r) => r.id !== oldKeys.id)!;
    expect(oldRow.retiredAt).not.toBeNull();
    expect(newRow.retiredAt).toBeNull();
    expect((await getLocalKeys())!.id).toBe(newRow.id);
    expect(result.publicKey).toBe(newRow.publicKey);
    expect(typeof result.rotatedAt).toBe('number');

    // One push per ACTIVE peer, none to the pending one.
    const pushes = calls.filter((c) => c.url.endsWith('/federation/key-rotation'));
    expect(pushes.map((c) => new URL(c.url).hostname).sort()).toEqual([PEER_A, PEER_B].sort());
    expect(calls.some((c) => c.url.includes(PEER_PENDING))).toBe(false);
    expect(result.notified.sort()).toEqual([PEER_A, PEER_B].sort());
    expect(result.failed).toEqual([]);
    expect(result.unsupported).toEqual([]);

    for (const push of pushes) {
      expect(push.body.newPublicKey).toBe(newRow.publicKey);
      expect(push.body.rotatedAt).toBe(result.rotatedAt);
      expect(push.body.fromDomain).toBe('test.local');
      // Signed with the OLD key, for that peer.
      const peer = new URL(push.url).hostname;
      await expect(
        jwtVerify(push.body.signature as string, await importJWK(oldKeys.publicKey, 'EdDSA'), {
          audience: peer,
          issuer: 'test.local'
        })
      ).resolves.toBeDefined();
      await expect(
        jwtVerify(push.body.signature as string, await importJWK(JSON.parse(newRow.publicKey), 'EdDSA'), {
          audience: peer
        })
      ).rejects.toThrow();
    }
  });

  test('a peer answering 404 is reported as unsupported and marked on its row', async () => {
    const { caller } = await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_A);
    await seedPeerInstance(PEER_B);
    const { calls } = spyOnFetch((call) =>
      new Response('{}', { status: call.url.includes(PEER_B) ? 404 : 200 })
    );

    const result = await caller.federation.rotateKeys();

    expect(result.notified).toEqual([PEER_A]);
    expect(result.unsupported).toEqual([PEER_B]);
    expect(result.failed).toEqual([]);
    // No retries against a 404.
    expect(calls.filter((c) => c.url.includes(PEER_B))).toHaveLength(1);

    const [rowB] = await getTestDb()
      .select({ lastError: federationInstances.lastError })
      .from(federationInstances)
      .where(eq(federationInstances.domain, PEER_B));
    expect(rowB!.lastError).toBe('unsupported:/federation/key-rotation');
  });

  test('refuses when no key has been generated, leaving the table empty', async () => {
    const { caller } = await initTest(1);

    await expect(caller.federation.rotateKeys()).rejects.toThrow('Federation keys not generated');
    expect(await getTestDb().select().from(federationKeys)).toHaveLength(0);
  });

  test('is instance-owner only', async () => {
    const { caller } = await initTest(2);
    await generateFederationKeys();

    await expect(caller.federation.rotateKeys()).rejects.toMatchObject({
      code: 'FORBIDDEN'
    });
    const rows = await getTestDb().select().from(federationKeys);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.retiredAt).toBeNull();
  });
});
