import type { TServerInfo } from '@pulse/shared';
import { afterEach, describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';

describe('/info', () => {
  const enableOidc = () => {
    process.env.OIDC_OAUTH_ENABLED = 'true';
    process.env.OIDC_ISSUER = 'https://auth.example.com/application/o/pulse/';
    process.env.OIDC_CLIENT_ID = 'client-123';
    process.env.OIDC_SECRET = 'secret-456';
    process.env.AUTH_SECRET = 'test-oidc-secret-at-least-32-chars-long!!';
  };

  afterEach(() => {
    delete process.env.GOOGLE_OAUTH_ENABLED;
    delete process.env.OIDC_OAUTH_ENABLED;
    delete process.env.OIDC_LABEL;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_SECRET;
    delete process.env.AUTH_SECRET;
    globalThis.__disabledRegistrationMethods = undefined;
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

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.enabledAuthProviders).toContainEqual({
      name: 'google',
      label: 'Google'
    });
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

  test('OIDC provider is absent unless enabled', async () => {
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(
      (data.enabledAuthProviders ?? []).some((p) => p.name === 'oidc')
    ).toBe(false);
  });
});
