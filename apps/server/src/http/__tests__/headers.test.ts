import { afterEach, describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';

const ORIGINAL_TRUST_PROXY = process.env.TRUST_PROXY;
const ORIGINAL_PUBLIC_URL = process.env.PUBLIC_URL;

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

// The origin helpers read env per request, so toggling here steers the
// live test server without a restart.
afterEach(() => {
  restore('TRUST_PROXY', ORIGINAL_TRUST_PROXY);
  restore('PUBLIC_URL', ORIGINAL_PUBLIC_URL);
});

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
