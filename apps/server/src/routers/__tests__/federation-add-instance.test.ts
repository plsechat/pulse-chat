/**
 * federation.addInstance — outbound peering handshake.
 *
 * The regression under test: the challenge JWT's audience must be the
 * remote's ADVERTISED Instance Domain (from /federation/info), not the
 * host of the URL the admin happened to dial. verifyChallenge on the
 * receiving side checks `aud` against its own configured domain, so
 * deriving the audience from the dial URL broke peering with a cryptic
 * "Invalid signature" whenever the two strings differed (custom port,
 * LAN hostname, proxy alias).
 *
 * federationFetch is mocked at the module level: /federation/info
 * returns a scripted TFederationInfo and /federation/request captures
 * the signed body for inspection.
 */

import { describe, expect, mock, test } from 'bun:test';
import { decodeJwt } from 'jose';

// Must be registered before the route module graph pulls in the real
// implementation (bun rewires already-loaded importers too, but being
// first keeps this independent of load order).
type TFetchCall = { url: string; body?: unknown };
const fetchCalls: TFetchCall[] = [];
let scriptedInfo: Record<string, unknown> = {};
let scriptedRequestStatus = 200;
let scriptedRequestBody: Record<string, unknown> = { success: true };

// The real validateFederationUrl resolves DNS (SSRF guard) — fake test
// hostnames would fail there before ever reaching the mocked fetch. The
// SSRF validator has its own coverage; here we test the orchestration.
mock.module('../../utils/validate-url', () => ({
  validateFederationUrl: async (urlString: string) => new URL(urlString),
  getFederationProtocol: () => 'http',
  isPrivateIp: () => false
}));

mock.module('../../utils/federation-fetch', () => ({
  federationFetch: async (
    url: string,
    init?: { method?: string; body?: string }
  ) => {
    const call: TFetchCall = { url };
    if (init?.body) call.body = JSON.parse(init.body);
    fetchCalls.push(call);

    if (url.includes('/federation/info')) {
      return new Response(JSON.stringify(scriptedInfo), { status: 200 });
    }
    if (url.includes('/federation/request')) {
      return new Response(JSON.stringify(scriptedRequestBody), {
        status: scriptedRequestStatus
      });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }
}));

const { config } = await import('../../config');
const { initTest } = await import('../../__tests__/helpers');
const { generateFederationKeys } = await import('../../utils/federation');

// Handlers short-circuit when federation is disabled; the mock-modules
// default is disabled. Per-file process isolation keeps this local.
config.federation.enabled = true;
config.federation.domain = 'test.local';

const resetScript = () => {
  fetchCalls.length = 0;
  scriptedRequestStatus = 200;
  scriptedRequestBody = { success: true };
};

describe('federation.addInstance', () => {
  test('signs the challenge for the ADVERTISED domain, not the dial host', async () => {
    resetScript();
    const { caller } = await initTest(1);
    await generateFederationKeys();

    // Remote is dialed as pulse-b:4991 but advertises plain "peer.example"
    scriptedInfo = {
      domain: 'peer.example',
      name: 'Peer',
      version: '0.0.0',
      publicKey: '{}',
      federationEnabled: true
    };

    const result = await caller.federation.addInstance({
      remoteUrl: 'http://pulse-b:4991'
    });

    // The canonical stored identity is the advertised domain
    expect(result).toBeDefined();
    expect(result!.instance.domain).toBe('peer.example');

    const requestCall = fetchCalls.find((c) =>
      c.url.includes('/federation/request')
    );
    expect(requestCall).toBeDefined();

    const body = requestCall!.body as { signature: string; domain: string };
    expect(body.domain).toBe('test.local');

    const claims = decodeJwt(body.signature);
    expect(claims.aud).toBe('peer.example');
    expect(claims.iss).toBe('test.local');

    // The advertised-domain reachability pre-check must have dialed the
    // advertised domain's /federation/info (advertised ≠ dial host here).
    const reachabilityCheck = fetchCalls.filter((c) =>
      c.url.includes('/federation/info')
    );
    expect(
      reachabilityCheck.some((c) => c.url.includes('peer.example'))
    ).toBe(true);
  });

  test('surfaces the remote rejection reason instead of a generic failure', async () => {
    resetScript();
    const { caller } = await initTest(1);
    await generateFederationKeys();

    scriptedInfo = {
      domain: 'peer2.example',
      name: 'Peer2',
      version: '0.0.0',
      publicKey: '{}',
      federationEnabled: true
    };
    scriptedRequestStatus = 401;
    scriptedRequestBody = { error: 'Invalid signature' };

    await expect(
      caller.federation.addInstance({ remoteUrl: 'http://peer2.example' })
    ).rejects.toThrow('Invalid signature');
  });

  test('rejects a remote that advertises no Instance Domain', async () => {
    resetScript();
    const { caller } = await initTest(1);
    await generateFederationKeys();

    scriptedInfo = {
      domain: '',
      name: 'Broken',
      version: '0.0.0',
      publicKey: '{}',
      federationEnabled: true
    };

    await expect(
      caller.federation.addInstance({ remoteUrl: 'http://broken.example' })
    ).rejects.toThrow('does not advertise');
  });
});
