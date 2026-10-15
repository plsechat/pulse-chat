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
 * The real `validateFederationUrl` + `federationFetch` run; only the
 * edges are stubbed, per test and restorably: DNS resolves every
 * hostname to a public IP (so the SSRF guard accepts the fake peers)
 * and `globalThis.fetch` scripts /federation/info and
 * /federation/request. `mock.module` is deliberately NOT used — it is
 * process-global and irreversible, and leaked stubs into every later
 * file that imported either module.
 */

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { decodeJwt } from 'jose';
import { config } from '../../config';
import {
  mockDns,
  spyOnFetch,
  type FetchCall
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../../utils/federation';
import { _resetFederationRateLimit } from '../../utils/federation-fetch';

// Handlers short-circuit when federation is disabled; the mock-modules
// default is disabled. The config object is shared by every file in
// the process, so put the flag back when this file is done.
const previousFederationEnabled = config.federation.enabled;
config.federation.enabled = true;
config.federation.domain = 'test.local';

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  config.federation.enabled = previousFederationEnabled;
});

type Script = {
  info: Record<string, unknown>;
  requestStatus?: number;
  requestBody?: Record<string, unknown>;
};

/**
 * Stub the network for one addInstance call: GET /federation/info on
 * any host returns `info`; POST /federation/request returns the
 * scripted status/body. Returns the recorded calls for inspection.
 */
const scriptRemote = (script: Script): { calls: FetchCall[] } => {
  mockDns();
  _resetFederationRateLimit();
  return spyOnFetch((call) => {
    if (call.url.includes('/federation/info')) {
      return new Response(JSON.stringify(script.info), { status: 200 });
    }
    if (call.url.includes('/federation/request')) {
      return new Response(JSON.stringify(script.requestBody ?? { success: true }), {
        status: script.requestStatus ?? 200
      });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  });
};

describe('federation.addInstance', () => {
  test('signs the challenge for the ADVERTISED domain, not the dial host', async () => {
    const { caller } = await initTest(1);
    await generateFederationKeys();

    // Remote is dialed as pulse-b:4991 but advertises plain "peer.example"
    const { calls } = scriptRemote({
      info: {
        domain: 'peer.example',
        name: 'Peer',
        version: '0.0.0',
        publicKey: '{}',
        federationEnabled: true
      }
    });

    const result = await caller.federation.addInstance({
      remoteUrl: 'http://pulse-b:4991'
    });

    // The canonical stored identity is the advertised domain
    expect(result).toBeDefined();
    expect(result!.instance.domain).toBe('peer.example');

    const requestCall = calls.find((c) =>
      c.url.includes('/federation/request')
    );
    expect(requestCall).toBeDefined();
    expect(requestCall!.method).toBe('POST');
    // The request goes to the dialed origin, not the advertised domain
    expect(requestCall!.url).toBe('http://pulse-b:4991/federation/request');

    const body = requestCall!.body as { signature: string; domain: string };
    expect(body.domain).toBe('test.local');

    const claims = decodeJwt(body.signature);
    expect(claims.aud).toBe('peer.example');
    expect(claims.iss).toBe('test.local');

    // The advertised-domain reachability pre-check must have dialed the
    // advertised domain's /federation/info (advertised ≠ dial host here).
    const infoChecks = calls.filter((c) => c.url.includes('/federation/info'));
    expect(infoChecks.some((c) => c.url.includes('peer.example'))).toBe(true);
  });

  test('surfaces the remote rejection reason instead of a generic failure', async () => {
    const { caller } = await initTest(1);
    await generateFederationKeys();

    scriptRemote({
      info: {
        domain: 'peer2.example',
        name: 'Peer2',
        version: '0.0.0',
        publicKey: '{}',
        federationEnabled: true
      },
      requestStatus: 401,
      requestBody: { error: 'Invalid signature' }
    });

    await expect(
      caller.federation.addInstance({ remoteUrl: 'http://peer2.example' })
    ).rejects.toThrow('Invalid signature');
  });

  test('rejects a remote that advertises no Instance Domain', async () => {
    const { caller } = await initTest(1);
    await generateFederationKeys();

    scriptRemote({
      info: {
        domain: '',
        name: 'Broken',
        version: '0.0.0',
        publicKey: '{}',
        federationEnabled: true
      }
    });

    await expect(
      caller.federation.addInstance({ remoteUrl: 'http://broken.example' })
    ).rejects.toThrow('does not advertise');
  });
});
