import type { TServerInfo } from '@pulse/shared';
import { afterEach, describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';
import { config } from '../../config';
import { authBackend } from '../../utils/auth';

// Social OAuth providers are advertised only under AUTH_BACKEND=supabase.
// The preloaded auth mock reports `local`; tests flip it where needed.
const BACKEND = authBackend as { kind: string };
const ORIGINAL_KIND = BACKEND.kind;

describe('/info', () => {
  const enableOidc = () => {
    process.env.OIDC_OAUTH_ENABLED = 'true';
    process.env.OIDC_ISSUER = 'https://auth.example.com/application/o/pulse/';
    process.env.OIDC_CLIENT_ID = 'client-123';
    process.env.OIDC_SECRET = 'secret-456';
    process.env.AUTH_SECRET = 'test-oidc-secret-at-least-32-chars-long!!';
  };

  afterEach(() => {
    config.webrtc.turn = { urls: [], username: '', credential: '' };
    config.webrtc.iceTransportPolicy = 'all';
    delete process.env.GOOGLE_OAUTH_ENABLED;
    delete process.env.OIDC_OAUTH_ENABLED;
    delete process.env.OIDC_LABEL;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_SECRET;
    delete process.env.AUTH_SECRET;
    globalThis.__disabledRegistrationMethods = undefined;
    BACKEND.kind = ORIGINAL_KIND;
  });

  test('passwordRegistrationEnabled is true by default', async () => {
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;
    expect(data.passwordRegistrationEnabled).toBe(true);
  });

  test('passwordRegistrationEnabled is false when password registration is disabled', async () => {
    globalThis.__disabledRegistrationMethods = ['password'];
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;
    expect(data.passwordRegistrationEnabled).toBe(false);
  });

  test('passwordLoginEnabled is true by default', async () => {
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;
    expect(data.passwordLoginEnabled).toBe(true);
  });

  test('passwordLoginEnabled is false in SSO-only mode (password registration off + provider advertised)', async () => {
    globalThis.__disabledRegistrationMethods = ['password'];
    process.env.GOOGLE_OAUTH_ENABLED = 'true';
    BACKEND.kind = 'supabase';
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;
    expect(data.passwordLoginEnabled).toBe(false);
  });

  test('passwordLoginEnabled stays true when password registration is off but NO provider is configured', async () => {
    // Guard rail: without any SSO provider, hiding password login would
    // leave the deployment with no way to sign in at all.
    globalThis.__disabledRegistrationMethods = ['password'];
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;
    expect(data.passwordLoginEnabled).toBe(true);
  });

  test('should return server info', async () => {
    const response = await fetch(`${testsBaseUrl}/info`);

    expect(response.status).toBe(200);

    const data = (await response.json()) as TServerInfo;

    expect(data).toHaveProperty('serverId');
    expect(data).toHaveProperty('version');
    expect(data).toHaveProperty('name');
    expect(data).toHaveProperty('description');
    expect(data).toHaveProperty('logo');
    expect(data).toHaveProperty('allowNewUsers');

    expect(data.name).toBe('Test Server');
    expect(data.description).toBe('Test server description');
    expect(data.allowNewUsers).toBe(true);
  });

  test('built-in providers carry a name and a label', async () => {
    process.env.GOOGLE_OAUTH_ENABLED = 'true';
    BACKEND.kind = 'supabase';

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.enabledAuthProviders).toContainEqual({
      name: 'google',
      label: 'Google'
    });
  });

  test('social providers are NOT advertised under AUTH_BACKEND=local, and password login stays enabled', async () => {
    // Under the local backend there is no Supabase client to run the
    // flow: the toggle is dead and must neither show a button nor count
    // as an SSO provider for the SSO-only derivation.
    process.env.GOOGLE_OAUTH_ENABLED = 'true';
    globalThis.__disabledRegistrationMethods = ['password'];
    BACKEND.kind = 'local';

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect((data.enabledAuthProviders ?? []).some((p) => p.name === 'google')).toBe(false);
    expect(data.passwordLoginEnabled).toBe(true);
  });

  test('native OIDC provider is advertised with kind and custom label', async () => {
    enableOidc();
    process.env.OIDC_LABEL = 'Authentik';

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.enabledAuthProviders).toContainEqual({
      name: 'oidc',
      label: 'Authentik',
      kind: 'oidc'
    });
  });

  test('native OIDC provider falls back to a default label', async () => {
    enableOidc();

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.enabledAuthProviders).toContainEqual({
      name: 'oidc',
      label: 'Single Sign-On',
      kind: 'oidc'
    });
  });

  test('OIDC provider is absent when only the flag is set (missing issuer/secret)', async () => {
    process.env.OIDC_OAUTH_ENABLED = 'true';

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(
      (data.enabledAuthProviders ?? []).some((p) => p.name === 'oidc')
    ).toBe(false);
  });

  test('ICE block is absent when no TURN relay is configured', async () => {
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data).not.toHaveProperty('iceServers');
    expect(data).not.toHaveProperty('iceTransportPolicy');
  });

  test('ICE block carries the relay (credential included) and a non-default policy', async () => {
    // The mocked config is a plain object: the env parsing itself is
    // covered by helpers/__tests__/webrtc-ice.test.ts.
    config.webrtc.turn = {
      urls: ['turn:relay.example.com:3478?transport=udp', 'turns:relay.example.com:5349'],
      username: 'pulse',
      credential: 'time-limited-secret'
    };
    config.webrtc.iceTransportPolicy = 'relay';

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.iceServers).toEqual([
      {
        urls: ['turn:relay.example.com:3478?transport=udp', 'turns:relay.example.com:5349'],
        username: 'pulse',
        credential: 'time-limited-secret'
      }
    ]);
    expect(data.iceTransportPolicy).toBe('relay');
  });

  test('ICE block omits empty credentials and the default "all" policy', async () => {
    config.webrtc.turn = {
      urls: ['stun:stun.example.com:3478'],
      username: '',
      credential: ''
    };

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.iceServers).toEqual([{ urls: ['stun:stun.example.com:3478'] }]);
    expect(data).not.toHaveProperty('iceTransportPolicy');
  });

  test('OIDC provider is absent unless enabled', async () => {
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(
      (data.enabledAuthProviders ?? []).some((p) => p.name === 'oidc')
    ).toBe(false);
  });
});
