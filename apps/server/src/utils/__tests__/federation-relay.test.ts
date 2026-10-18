/**
 * relayToInstanceDetailed — failure kinds and the instance row mirror.
 *
 * A 404 is `unsupported` (the peer predates the route; the outbox
 * dead-letters it), other statuses and transport errors are retryable,
 * and every outcome lands on federation_instances.last_error so the
 * owner's panel can show a degraded peer; the next 2xx clears it. The
 * boolean `relayToInstance` wrapper keeps the dispatchers' contract.
 *
 * Fetch + DNS are spied via the shared fixtures and restored by
 * `mock.restore()`.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
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
import { federationInstances } from '../../db/schema';
import {
  generateFederationKeys,
  getLocalKeys,
  relayToInstance,
  relayToInstanceDetailed,
  rotateLocalFederationKeys
} from '../federation';
import {
  _resetFederationRateLimit,
  _tryConsumeFederationToken
} from '../federation-fetch';

config.federation.enabled = true;

const PEER_DOMAIN = 'relay.peer.example.com';
const PATH = '/federation/user-info-update';

afterEach(() => {
  mock.restore();
  _resetFederationRateLimit();
});

const peerRow = async () => {
  const [row] = await getTestDb()
    .select({
      lastError: federationInstances.lastError,
      lastErrorAt: federationInstances.lastErrorAt
    })
    .from(federationInstances)
    .where(eq(federationInstances.domain, PEER_DOMAIN));
  return row!;
};

const setup = async () => {
  await initTest(1);
  await generateFederationKeys();
  mockDns();
  await seedPeerInstance(PEER_DOMAIN);
};

describe('relayToInstanceDetailed', () => {
  test('a 404 is unsupported and recorded as unsupported:<path>', async () => {
    await setup();
    spyOnFetch(() => new Response('{}', { status: 404 }));

    const outcome = await relayToInstanceDetailed(PEER_DOMAIN, PATH, { x: 1 });

    expect(outcome).toEqual({
      ok: false,
      status: 404,
      unsupported: true,
      error: `unsupported:${PATH}`
    });
    const row = await peerRow();
    expect(row.lastError).toBe(`unsupported:${PATH}`);
    expect(row.lastErrorAt).toBeGreaterThan(Date.now() - 10_000);
  });

  test('another non-2xx is retryable and recorded with its status', async () => {
    await setup();
    spyOnFetch(() => new Response('{}', { status: 503 }));

    const outcome = await relayToInstanceDetailed(PEER_DOMAIN, PATH, { x: 1 });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe(503);
    expect(outcome.unsupported).toBe(false);
    expect((await peerRow()).lastError).toBe('http:503');
  });

  test('a transport failure is retryable and recorded with a short reason', async () => {
    await setup();
    spyOnFetch(() => {
      throw new Error('connect ECONNREFUSED');
    });

    const outcome = await relayToInstanceDetailed(PEER_DOMAIN, PATH, { x: 1 });

    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBeUndefined();
    expect(outcome.unsupported).toBeUndefined();
    expect(outcome.error).toContain('ECONNREFUSED');
    expect((await peerRow()).lastError).toContain('ECONNREFUSED');
  });

  test('our own rate limiter is reported as rateLimited, nothing sent', async () => {
    await setup();
    const { calls } = spyOnFetch();
    for (let i = 0; i < 60; i++) _tryConsumeFederationToken(PEER_DOMAIN);

    const outcome = await relayToInstanceDetailed(PEER_DOMAIN, PATH, { x: 1 });

    expect(outcome.ok).toBe(false);
    expect(outcome.rateLimited).toBe(true);
    expect(outcome.unsupported).toBeUndefined();
    expect(outcome.error).toContain('FederationRateLimitError');
    expect(calls).toHaveLength(0);
  });

  test('a 2xx clears a previously recorded error', async () => {
    await setup();
    await getTestDb()
      .update(federationInstances)
      .set({ lastError: 'http:500', lastErrorAt: Date.now() - 1000 })
      .where(eq(federationInstances.domain, PEER_DOMAIN));
    const { calls } = spyOnFetch();

    const outcome = await relayToInstanceDetailed(PEER_DOMAIN, PATH, { x: 1 });

    expect(outcome).toEqual({ ok: true, status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://${PEER_DOMAIN}${PATH}`);
    expect(calls[0]!.body.fromDomain).toBe('test.local');
    expect(typeof calls[0]!.body.signature).toBe('string');
    const row = await peerRow();
    expect(row.lastError).toBeNull();
    expect(row.lastErrorAt).toBeNull();
  });

  test('signingKeys signs with the given pair instead of the live key', async () => {
    await setup();
    const old = (await getLocalKeys())!;
    const { next } = await rotateLocalFederationKeys();
    const { calls } = spyOnFetch();

    await relayToInstanceDetailed(PEER_DOMAIN, '/federation/key-rotation', { x: 1 }, {
      signingKeys: old
    });

    const signature = calls[0]!.body.signature as string;
    await expect(
      jwtVerify(signature, await importJWK(old.publicKey, 'EdDSA'), {
        audience: PEER_DOMAIN,
        issuer: 'test.local'
      })
    ).resolves.toBeDefined();
    await expect(
      jwtVerify(signature, await importJWK(next.publicKey, 'EdDSA'), {
        audience: PEER_DOMAIN
      })
    ).rejects.toThrow();
  });

  test('relayToInstance keeps the boolean contract', async () => {
    await setup();
    spyOnFetch((call) =>
      new Response('{}', { status: call.body.fail ? 500 : 200 })
    );

    expect(await relayToInstance(PEER_DOMAIN, PATH, { fail: false })).toBe(true);
    expect(await relayToInstance(PEER_DOMAIN, PATH, { fail: true })).toBe(false);
  });
});
