import { UploadHeaders } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';

// The test server runs with IS_DEVELOPMENT=true (mocked env), where any
// Origin is reflected — exactly the case that must never also carry
// Allow-Credentials.

describe('CORS', () => {
  test('OPTIONS /upload: allow-headers covers every upload header', async () => {
    const response = await fetch(`${testsBaseUrl}/upload`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://peer.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-file-encrypted'
      }
    });

    expect(response.status).toBe(204);

    const allowHeaders = response.headers
      .get('access-control-allow-headers')!
      .toLowerCase();

    for (const header of Object.values(UploadHeaders)) {
      expect(allowHeaders).toContain(header.toLowerCase());
    }
    expect(allowHeaders).toContain('x-file-encrypted');
    expect(allowHeaders).toContain('x-federation-token');
    expect(allowHeaders).toContain('x-pulse-request-id');
    expect(allowHeaders).toContain('authorization');
    expect(allowHeaders).toContain('content-type');
  });

  test('reflected origin never carries Allow-Credentials and sets Vary: Origin', async () => {
    const response = await fetch(`${testsBaseUrl}/healthz`, {
      headers: { Origin: 'https://peer.example' }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'https://peer.example'
    );
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  test('a request without Origin gets no allow-origin but still Vary: Origin', async () => {
    const response = await fetch(`${testsBaseUrl}/healthz`);

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  test('an unparsable Origin is not reflected', async () => {
    const response = await fetch(`${testsBaseUrl}/healthz`, {
      headers: { Origin: 'not a url' }
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
