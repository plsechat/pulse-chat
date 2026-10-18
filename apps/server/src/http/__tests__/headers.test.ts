import { afterEach, describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';
import { db } from '../../db';
import { federationInstances } from '../../db/schema';
import { invalidateCorsCache } from '../cors';

const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;
const ORIGINAL_PUBLIC_URL = process.env.PUBLIC_URL;
const ORIGINAL_PRIVATE_CIDRS = process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;

// The policy with no plain-http peers — byte for byte what every
// deployment without LAN federation must keep sending.
const BASELINE_CSP =
  "default-src 'self'; script-src 'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://s.ytimg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; media-src 'self' https: blob:; connect-src 'self' https: wss: ws: blob:; font-src 'self'; frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com https://open.spotify.com https://w.soundcloud.com https://platform.twitter.com https://syndication.twitter.com https://www.reddit.com https://embed.reddit.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

// The origin helpers read env per request, so toggling here steers the
// live test server without a restart.
afterEach(() => {
  restore('TRUST_PROXY', ORIGINAL_TRUST_PROXY);
  restore('PUBLIC_URL', ORIGINAL_PUBLIC_URL);
  restore('FEDERATION_ALLOW_PRIVATE_CIDRS', ORIGINAL_PRIVATE_CIDRS);
  // The peer list is cached for a minute; the rows are truncated before
  // the next test, so the cache must go with them.
  invalidateCorsCache();
});

const seedPeer = (domain: string, status: 'active' | 'pending' | 'blocked') =>
  db.insert(federationInstances).values({
    domain,
    name: domain,
    status,
    direction: 'outgoing',
    createdAt: Date.now()
  });

const fetchCsp = async () => {
  const response = await fetch(`${testsBaseUrl}/healthz`);
  return response.headers.get('content-security-policy')!;
};

describe('security headers', () => {
  test('no HSTS on a plain-http request', async () => {
    delete process.env.TRUST_PROXY;
    delete process.env.PUBLIC_URL;

    const response = await fetch(`${testsBaseUrl}/healthz`, {
      headers: { 'x-forwarded-proto': 'https' }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('strict-transport-security')).toBeNull();
  });

  test('HSTS when a trusted proxy reports https', async () => {
    process.env.TRUST_PROXY = 'true';
    delete process.env.PUBLIC_URL;

    const response = await fetch(`${testsBaseUrl}/healthz`, {
      headers: { 'x-forwarded-proto': 'https' }
    });

    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains'
    );

    const plain = await fetch(`${testsBaseUrl}/healthz`, {
      headers: { 'x-forwarded-proto': 'http' }
    });

    expect(plain.headers.get('strict-transport-security')).toBeNull();
  });

  test('HSTS when PUBLIC_URL is https', async () => {
    delete process.env.TRUST_PROXY;
    process.env.PUBLIC_URL = 'https://pulse.example.com';

    const response = await fetch(`${testsBaseUrl}/healthz`);

    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains'
    );
  });

  test('Permissions-Policy, CSP without unsafe-eval, and the frame/sniff guards', async () => {
    const response = await fetch(`${testsBaseUrl}/healthz`);

    expect(response.headers.get('permissions-policy')).toBe(
      'camera=(self), microphone=(self), display-capture=(self), geolocation=()'
    );

    const csp = response.headers.get('content-security-policy')!;
    // Scripts: the app's own, plus the YouTube player API the
    // watch-together card loads — path-scoped on www.youtube.com.
    expect(csp).toContain(
      "script-src 'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://s.ytimg.com;"
    );
    expect(csp).not.toContain('unsafe-eval');
    // Images: link previews come from anywhere over https, which is
    // also what the watch card's YouTube thumbnail (i.ytimg.com) needs;
    // the directive stays exactly this wide and no wider.
    expect(csp).toContain("img-src 'self' data: https: blob:;");
    expect(csp).toContain("frame-src https://www.youtube-nocookie.com https://www.youtube.com ");
    expect(csp).toContain("frame-ancestors 'none'");

    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe(
      'strict-origin-when-cross-origin'
    );
  });
});

describe('CSP and plain-http federation peers', () => {
  test('with no peers the policy is exactly the baseline', async () => {
    invalidateCorsCache();
    expect(await fetchCsp()).toBe(BASELINE_CSP);
  });

  test('an active plain-http peer is a source for images, media and connections', async () => {
    // A bare hostname is an http peer once the operator has opted into
    // private-network federation (the LAN / compose case).
    process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '172.16.0.0/12';
    await seedPeer('pulse-peer-b:4991', 'active');
    invalidateCorsCache();

    const csp = await fetchCsp();
    expect(csp).toContain(
      "img-src 'self' data: https: blob: http://pulse-peer-b:4991;"
    );
    expect(csp).toContain(
      "media-src 'self' https: blob: http://pulse-peer-b:4991;"
    );
    expect(csp).toContain(
      "connect-src 'self' https: wss: ws: blob: http://pulse-peer-b:4991;"
    );
    // Nothing else moved.
    expect(csp.replaceAll(' http://pulse-peer-b:4991', '')).toBe(BASELINE_CSP);

    // The peer is removed: the next invalidation drops the source again.
    await db.delete(federationInstances);
    invalidateCorsCache();
    expect(await fetchCsp()).toBe(BASELINE_CSP);
  });

  test('https, pending and blocked peers leave the policy unchanged', async () => {
    process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '172.16.0.0/12';
    // Dotted hostnames federate over https — already covered by `https:`.
    await seedPeer('peer.example.com', 'active');
    // Not (or no longer) peered: never a source.
    await seedPeer('pulse-pending:4991', 'pending');
    await seedPeer('pulse-blocked:4991', 'blocked');
    invalidateCorsCache();

    expect(await fetchCsp()).toBe(BASELINE_CSP);
  });

  test('a bare hostname without the private-network opt-in stays https', async () => {
    delete process.env.FEDERATION_ALLOW_PRIVATE_CIDRS;
    await seedPeer('pulse-peer-b:4991', 'active');
    invalidateCorsCache();

    expect(await fetchCsp()).toBe(BASELINE_CSP);
  });

  test('allowlisted private IPs: v4 by host, v6 as the bare http: scheme', async () => {
    process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '192.168.0.0/16,fd00::/8';
    await seedPeer('192.168.1.5:4991', 'active');
    await seedPeer('[fd00::1]:4991', 'active');
    invalidateCorsCache();

    const csp = await fetchCsp();
    expect(csp).toContain(
      "img-src 'self' data: https: blob: http: http://192.168.1.5:4991;"
    );
    expect(csp).toContain(
      "connect-src 'self' https: wss: ws: blob: http: http://192.168.1.5:4991;"
    );
  });

  test('the peer list is read once per cache generation', async () => {
    process.env.FEDERATION_ALLOW_PRIVATE_CIDRS = '172.16.0.0/12';
    await seedPeer('pulse-peer-b:4991', 'active');
    invalidateCorsCache();
    expect(await fetchCsp()).toContain('http://pulse-peer-b:4991');

    // A row change without invalidation is not visible until the TTL
    // lapses — the same contract the CORS allow-list already has, and
    // why every peer mutation route calls invalidateCorsCache.
    await db.delete(federationInstances);
    expect(await fetchCsp()).toContain('http://pulse-peer-b:4991');
    invalidateCorsCache();
    expect(await fetchCsp()).toBe(BASELINE_CSP);
  });
});

describe('/webhooks route matching', () => {
  test('an id wider than int4 is a 404, not a 500', async () => {
    const response = await fetch(`${testsBaseUrl}/webhooks/99999999999/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' })
    });

    expect(response.status).toBe(404);

    const thirtyDigits = await fetch(
      `${testsBaseUrl}/webhooks/${'9'.repeat(30)}/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'hi' })
      }
    );

    expect(thirtyDigits.status).toBe(404);
  });

  test('a query string is not swallowed into the token', async () => {
    // No webhook exists, so a well-formed path is a 404 from the handler;
    // a path with a query string must take the same route (not fall
    // through to the generic 404 or 500).
    const response = await fetch(`${testsBaseUrl}/webhooks/1/sometoken?wait=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' })
    });

    expect(response.status).toBe(404);

    const data = (await response.json()) as { error: string };
    expect(data.error).toBe('Webhook not found');
  });
});
