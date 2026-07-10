import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { invites } from '../../db/schema';

const register = (body: {
  email: string;
  password: string;
  displayName: string;
  invite?: string;
}) =>
  fetch(`${testsBaseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

const provision = (token: string, body?: { invite?: string }) =>
  fetch(`${testsBaseUrl}/auth/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body ?? {})
  });

const makeInvite = async (code: string) => {
  await getTestDb()
    .insert(invites)
    .values({
      code,
      creatorId: 1,
      serverId: 1,
      maxUses: 5,
      uses: 0,
      expiresAt: Date.now() + 86400000,
      createdAt: Date.now()
    });
};

afterEach(() => {
  globalThis.__disabledRegistrationMethods = undefined;
  globalThis.__registrationDisabled = false;
});

describe('per-method registration switches', () => {
  // ── password method (/register) ──

  describe('password (REGISTRATION_PASSWORD_ENABLED)', () => {
    test('blocks password self-registration without an invite when disabled', async () => {
      globalThis.__disabledRegistrationMethods = ['password'];

      const response = await register({
        email: 'pw-blocked@pulse.local',
        password: 'password123',
        displayName: 'PW Blocked'
      });

      expect(response.status).toBe(400);
      const data: any = await response.json();
      expect(data).toHaveProperty('errors');
    });

    test('a valid invite is a break-glass path when password is disabled', async () => {
      globalThis.__disabledRegistrationMethods = ['password'];
      await makeInvite('PW-BREAKGLASS');

      const response = await register({
        email: 'pw-invited@pulse.local',
        password: 'password123',
        displayName: 'PW Invited',
        invite: 'PW-BREAKGLASS'
      });

      expect(response.status).toBe(200);
      const data: any = await response.json();
      expect(data).toHaveProperty('success', true);

      const [used] = await getTestDb()
        .select()
        .from(invites)
        .where(eq(invites.code, 'PW-BREAKGLASS'))
        .limit(1);
      expect(used?.uses).toBe(1);
    });

    test('password registration still works when a DIFFERENT method is disabled', async () => {
      globalThis.__disabledRegistrationMethods = ['social'];

      const response = await register({
        email: 'pw-ok@pulse.local',
        password: 'password123',
        displayName: 'PW Ok'
      });

      expect(response.status).toBe(200);
    });
  });

  // ── social method (/auth/provision) ──

  describe('social (REGISTRATION_SOCIAL_ENABLED)', () => {
    test('blocks new social provisioning without an invite when disabled', async () => {
      globalThis.__disabledRegistrationMethods = ['social'];

      const response = await provision(crypto.randomUUID());

      expect(response.status).toBe(400);
      const data: any = await response.json();
      expect(data).toHaveProperty('errors');
    });

    test('a valid invite is a break-glass path when social is disabled', async () => {
      globalThis.__disabledRegistrationMethods = ['social'];
      await makeInvite('SOCIAL-BREAKGLASS');

      const response = await provision(crypto.randomUUID(), {
        invite: 'SOCIAL-BREAKGLASS'
      });

      expect(response.status).toBe(200);
      const data: any = await response.json();
      expect(data).toHaveProperty('success', true);
    });

    test('new social provisioning still works when only password is disabled (OIDC-only would keep social too — this proves independence)', async () => {
      globalThis.__disabledRegistrationMethods = ['password'];

      const response = await provision(crypto.randomUUID());

      expect(response.status).toBe(200);
    });

    test('existing users are unaffected when their method is disabled', async () => {
      // Provision a user while all methods are enabled.
      const token = crypto.randomUUID();
      expect((await provision(token)).status).toBe(200);

      // Now disable social; the existing user should still resolve fine.
      globalThis.__disabledRegistrationMethods = ['social'];
      expect((await provision(token)).status).toBe(200);
    });
  });

  // ── OIDC-only combination ──

  describe('OIDC-only combination (password + social disabled)', () => {
    test('blocks both password and social self-registration', async () => {
      globalThis.__disabledRegistrationMethods = ['password', 'social'];

      const pw = await register({
        email: 'oidconly-pw@pulse.local',
        password: 'password123',
        displayName: 'OIDC Only PW'
      });
      expect(pw.status).toBe(400);

      const social = await provision(crypto.randomUUID());
      expect(social.status).toBe(400);
    });
  });
});
