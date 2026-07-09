import type { TServerInfo } from '@pulse/shared';
import { afterEach, describe, expect, test } from 'bun:test';
import { testsBaseUrl } from '../../__tests__/setup';

describe('/info', () => {
  afterEach(() => {
    delete process.env.GOOGLE_OAUTH_ENABLED;
    delete process.env.OIDC_OAUTH_ENABLED;
    delete process.env.OIDC_LABEL;
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

  test('generic OIDC provider uses the keycloak slot with a custom label', async () => {
    process.env.OIDC_OAUTH_ENABLED = 'true';
    process.env.OIDC_LABEL = 'Authentik';

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.enabledAuthProviders).toContainEqual({
      name: 'keycloak',
      label: 'Authentik'
    });
  });

  test('generic OIDC provider falls back to a default label', async () => {
    process.env.OIDC_OAUTH_ENABLED = 'true';

    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(data.enabledAuthProviders).toContainEqual({
      name: 'keycloak',
      label: 'Single Sign-On'
    });
  });

  test('OIDC provider is absent unless explicitly enabled', async () => {
    const data = (await (await fetch(`${testsBaseUrl}/info`)).json()) as TServerInfo;

    expect(
      (data.enabledAuthProviders ?? []).some((p) => p.name === 'keycloak')
    ).toBe(false);
  });
});
