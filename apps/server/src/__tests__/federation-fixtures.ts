import { expect, mock, spyOn } from 'bun:test';
import dns from 'dns/promises';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { federationInstances } from '../db/schema';
import { logger } from '../logger';
import {
  _resetSeenJtis,
  _signChallengeAs,
  generateFederationKeys
} from '../utils/federation';
import { _resetBundleFetchRateLimit } from '../utils/bundle-fetch-rate-limit';
import { _resetAll as _resetRateLimitBuckets } from '../http/rate-limit-core';
import { getTestDb } from './mock-db';
import { testsBaseUrl } from './setup';

/**
 * Shared helpers for federation tests. Everything here is restorable:
 * `spyOnFetch` and `mockDns` go through `spyOn`, so a file-level
 * `afterEach(() => mock.restore())` puts `globalThis.fetch` and
 * `dns.resolve4/6` back. Never replace those with `mock.module` — bun's
 * module mocks are process-global and irreversible, and the preload
 * afterAll in setup.ts fails the run if a file leaks a fetch/dns mock.
 */

/** Default peer domain used by the signed-request helpers. */
const PEER_DOMAIN = 'peer.example';
/** Matches `config.federation.domain` in mock-modules.ts. */
const TEST_LOCAL_DOMAIN = 'test.local';

type FetchCall = {
  /**
   * The request as the peer sees it: `federationFetch` dials the
   * validated IP and carries the name in `Host`, so this is the URL
   * with the Host header put back — tests filter by peer domain.
   */
  url: string;
  /** The URL actually handed to fetch (pinned address). */
  dialedUrl: string;
  method: string;
  body: Record<string, unknown>;
  /** Lower-cased request headers. */
  headers: Record<string, string>;
};

type FetchResponder = (call: FetchCall) => Response | Promise<Response>;

const defaultResponder: FetchResponder = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

/**
 * Replace `globalThis.fetch` with a recording stub for the current test.
 * Every call is captured (URL, method, parsed JSON body, headers) and
 * answered by `respond` (default: 200 `{ ok: true }`). Requests to the
 * test HTTP server itself pass through unrecorded, so a handler test can
 * post to a route while the handler's own outbound calls are stubbed.
 * Restored by `mock.restore()`.
 */
function spyOnFetch(respond: FetchResponder = defaultResponder): {
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const realFetch = globalThis.fetch;
  const fakeFetch = mock(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u =
        typeof url === 'string'
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      if (u.startsWith(testsBaseUrl)) {
        return realFetch(url, init);
      }
      let body: Record<string, unknown> = {};
      if (init?.body) {
        try {
          body = JSON.parse(init.body as string);
        } catch {
          body = {};
        }
      }
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      let logicalUrl = u;
      if (headers.host) {
        try {
          const parsed = new URL(u);
          parsed.host = headers.host;
          logicalUrl = parsed.toString();
        } catch {
          // Not a parseable URL — report what was dialled.
        }
      }
      const call: FetchCall = {
        url: logicalUrl,
        dialedUrl: u,
        method: init?.method ?? 'GET',
        body,
        headers
      };
      calls.push(call);
      return respond(call);
    }
  );
  spyOn(globalThis, 'fetch').mockImplementation(
    fakeFetch as unknown as typeof fetch
  );
  return { calls };
}

/**
 * Point every hostname at a public IPv4 so `validateFederationUrl`
 * (the SSRF guard inside `federationFetch`) accepts real-format test
 * domains without touching the runner's resolver. Restored by
 * `mock.restore()`.
 */
function mockDns(): void {
  spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
  spyOn(dns, 'resolve6').mockRejectedValue(new Error('NODATA'));
}

/**
 * Insert an active peer instance row with a placeholder public key.
 * Enough for outbound-dispatch tests, where only the domain matters;
 * use `seedPeer` when the test must verify signatures from the peer.
 */
async function seedPeerInstance(domain: string): Promise<number> {
  const [instance] = await getTestDb()
    .insert(federationInstances)
    .values({
      domain,
      name: domain,
      status: 'active',
      direction: 'outgoing',
      publicKey: '{"kty":"OKP","crv":"Ed25519","x":"placeholder"}',
      createdAt: Date.now()
    })
    .returning();
  return instance!.id;
}

type PeerSetup = {
  peerInstanceId: number;
  peerPrivateJwk: JWK;
};

/**
 * Create the local instance's federation keys plus an active peer row
 * signed with a fresh peer keypair, so `verifyChallenge` accepts
 * requests forged with `postSignedAsPeer`. Resets the jti replay set,
 * the bundle-fetch limiter and the per-peer budget buckets — all
 * module-level state that the between-test TRUNCATE does not touch.
 */
async function seedPeer(domain: string = PEER_DOMAIN): Promise<PeerSetup> {
  _resetSeenJtis();
  _resetBundleFetchRateLimit();
  _resetRateLimitBuckets();
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    extractable: true
  });
  const peerPublicJwk = await exportJWK(publicKey);
  const peerPrivateJwk = await exportJWK(privateKey);

  const [instance] = await getTestDb()
    .insert(federationInstances)
    .values({
      domain,
      name: 'Peer',
      status: 'active',
      direction: 'outgoing',
      publicKey: JSON.stringify(peerPublicJwk),
      createdAt: Date.now()
    })
    .returning();

  // signedJsonResponse signs responses with the local instance's key;
  // the global beforeEach TRUNCATE wipes it, so re-generate per test.
  await generateFederationKeys();

  return { peerInstanceId: instance!.id, peerPrivateJwk };
}

/**
 * POST `payload` to the test HTTP server as if it came from the peer:
 * `fromDomain` is added and the body is signed with the peer's key for
 * the local domain's audience.
 */
async function postSignedAsPeer(
  path: string,
  payload: Record<string, unknown>,
  peerPrivateJwk: JWK,
  peerDomain: string = PEER_DOMAIN
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const bodyToSign = { ...payload, fromDomain: peerDomain };
  const signature = await _signChallengeAs(
    bodyToSign,
    peerDomain,
    TEST_LOCAL_DOMAIN,
    peerPrivateJwk
  );

  const res = await fetch(`${testsBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...bodyToSign, signature })
  });
  let body: Record<string, unknown> | null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/**
 * Assert that a fire-and-forget dispatcher swallows a DB failure that
 * happens BEFORE any relay: `db.select` throws for the duration of the
 * call, the returned promise must still resolve (never reject — every
 * call site is `void fn()` with no catch, so a rejection would be
 * unhandled), and the failure must be logged at error level under
 * `[<tag>] dispatch failed`. The spy is undone by `mock.restore()` in
 * the caller's afterEach.
 */
async function expectDispatcherLogsDbError(
  run: () => Promise<void>,
  tag: string
): Promise<void> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);

  const errorLog = spyOn(logger, 'error');
  spyOn(getTestDb(), 'select').mockImplementation(() => {
    throw new Error('CONNECTION_ENDED');
  });

  try {
    // Deliberately not awaited first — mirrors the call sites.
    const pending = run();
    await new Promise((r) => setTimeout(r, 20));

    await expect(pending).resolves.toBeUndefined();
    expect(rejections).toHaveLength(0);
    expect(
      errorLog.mock.calls.some((args) =>
        String(args[0]).includes(`[${tag}] dispatch failed`)
      )
    ).toBe(true);
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

export {
  expectDispatcherLogsDbError,
  mockDns,
  PEER_DOMAIN,
  postSignedAsPeer,
  seedPeer,
  seedPeerInstance,
  spyOnFetch,
  TEST_LOCAL_DOMAIN,
  type FetchCall,
  type PeerSetup
};
