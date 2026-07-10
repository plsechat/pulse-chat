/**
 * Phase debug-logging / Phase 1 — cross-instance correlation header.
 *
 * Verifies the `X-Pulse-Request-Id` propagation that lets a single
 * trace span both sides of a federation call:
 *
 *   - Outbound `relayToInstance` / `queryInstance` reuse the active
 *     log-context's `requestId` if one is in scope, or mint a fresh
 *     id when called outside any scope.
 *   - The header value matches the in-scope context exactly, so a
 *     receiver that extracts and seeds its own context sees the
 *     same id the sender logged.
 */
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import dns from 'dns/promises';
import { config } from '../../config';
import { db } from '../../db';
import { federationInstances } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys, relayToInstance } from '../federation';
import { withLogContext } from '../log-context';

config.federation.enabled = true;

const PEER_DOMAIN = 'corr.example.com';

const originalFetch = globalThis.fetch;

type FetchCall = { url: string; headers: Record<string, string> };

function spyOnFetch(): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fakeFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k]!;
    }
    calls.push({ url: u, headers });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function mockDns() {
  spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
  spyOn(dns, 'resolve6').mockRejectedValue(new Error('NODATA'));
}

async function seedPeer(domain: string) {
  await db.insert(federationInstances).values({
    domain,
    name: domain,
    status: 'active',
    direction: 'outgoing',
    publicKey: '{"kty":"OKP","crv":"Ed25519","x":"placeholder"}',
    createdAt: Date.now()
  });
}

describe('cross-instance correlation header', () => {
  test('relayToInstance carries the active log-context requestId', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeer(PEER_DOMAIN);

    const { calls } = spyOnFetch();

    await withLogContext({ requestId: 'trace-from-test' }, async () => {
      await relayToInstance(PEER_DOMAIN, '/federation/info', {
        anything: 1
      });
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['x-pulse-request-id']).toBe('trace-from-test');
  });

  test('relayToInstance mints a fresh id when called outside any scope', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeer(PEER_DOMAIN);

    const { calls } = spyOnFetch();

    await relayToInstance(PEER_DOMAIN, '/federation/info', { x: 1 });

    expect(calls).toHaveLength(1);
    const id = calls[0]!.headers['x-pulse-request-id'];
    expect(typeof id).toBe('string');
    expect(id!.length).toBeGreaterThan(20);
  });
});
