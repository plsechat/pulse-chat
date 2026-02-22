import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { login } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { invites, users } from '../../db/schema';

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

afterEach(() => {
  globalThis.__registrationDisabled = false;
});

describe('REGISTRATION_DISABLED', () => {
  // ── /register endpoint ──

  describe('/register', () => {
    test('should block registration without invite when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const response = await register({
        email: 'blocked@pulse.local',
        password: 'password123',
        displayName: 'Blocked User'
      });

      expect(response.status).toBe(400);

      const data: any = await response.json();
      expect(data).toHaveProperty('errors');
    });

    test('should allow registration with valid invite when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const tdb = getTestDb();
      await tdb.insert(invites).values({
        code: 'REG-DISABLED-INVITE',
        creatorId: 1,
        serverId: 1,
        maxUses: 5,
        uses: 0,
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now()
      });

      const response = await register({
        email: 'invited@pulse.local',
        password: 'password123',
        displayName: 'Invited User',
        invite: 'REG-DISABLED-INVITE'
      });

      expect(response.status).toBe(200);

      const data: any = await response.json();
      expect(data).toHaveProperty('success', true);

      // Verify invite usage was incremented
      const [updatedInvite] = await tdb
        .select()
        .from(invites)
        .where(eq(invites.code, 'REG-DISABLED-INVITE'))
        .limit(1);

      expect(updatedInvite?.uses).toBe(1);
    });

    test('should reject expired invite when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const tdb = getTestDb();
      await tdb.insert(invites).values({
        code: 'EXPIRED-REG-INV',
        creatorId: 1,
        serverId: 1,
        maxUses: 5,
        uses: 0,
        expiresAt: Date.now() - 1000,
        createdAt: Date.now() - 86400000
      });

      const response = await register({
        email: 'expiredinv@pulse.local',
        password: 'password123',
        displayName: 'Expired Invite User',
        invite: 'EXPIRED-REG-INV'
      });

      expect(response.status).toBe(400);
    });

    test('should allow registration without invite when not disabled', async () => {
      const response = await register({
        email: 'allowed@pulse.local',
        password: 'password123',
        displayName: 'Allowed User'
      });

      expect(response.status).toBe(200);

      const data: any = await response.json();
      expect(data).toHaveProperty('success', true);
    });
  });

  // ── /login endpoint (auto-registration path) ──

  describe('/login', () => {
    test('should block auto-registration for new users when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const response = await login('newlogin@pulse.local', 'password123');

      expect(response.status).toBe(400);

      const data: any = await response.json();
      expect(data).toHaveProperty('errors');
      expect(data.errors).toHaveProperty('email');
      expect(data.errors.email).toContain('disabled');
    });

    test('should allow existing users to log in when disabled', async () => {
      // First, log in while registration is enabled to create the app user
      const firstLogin = await login('existinguser@pulse.local', 'password123');
      expect(firstLogin.status).toBe(200);

      // Now disable registration
      globalThis.__registrationDisabled = true;

      // Existing user should still be able to log in
      const response = await login('existinguser@pulse.local', 'password123');

      expect(response.status).toBe(200);

      const data: any = await response.json();
      expect(data).toHaveProperty('success', true);
      expect(data).toHaveProperty('accessToken');
    });
  });

  // ── /auth/provision endpoint (OAuth flow) ──

  describe('/auth/provision', () => {
    test('should block new user provisioning without invite when disabled', async () => {
      globalThis.__registrationDisabled = true;

      // Use a random token that won't match any existing user
      const token = crypto.randomUUID();

      const response = await provision(token);

      expect(response.status).toBe(400);

      const data: any = await response.json();
      expect(data).toHaveProperty('errors');
    });

    test('should allow new user provisioning with valid invite when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const tdb = getTestDb();
      await tdb.insert(invites).values({
        code: 'PROV-INVITE',
        creatorId: 1,
        serverId: 1,
        maxUses: 5,
        uses: 0,
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now()
      });

      const token = crypto.randomUUID();

      const response = await provision(token, { invite: 'PROV-INVITE' });

      expect(response.status).toBe(200);

      const data: any = await response.json();
      expect(data).toHaveProperty('success', true);

      // Verify invite usage was incremented
      const [updatedInvite] = await tdb
        .select()
        .from(invites)
        .where(eq(invites.code, 'PROV-INVITE'))
        .limit(1);

      expect(updatedInvite?.uses).toBe(1);
    });

    test('should allow existing user provisioning when disabled', async () => {
      // First provision while enabled to create the user
      const token = crypto.randomUUID();
      const firstResponse = await provision(token);
      expect(firstResponse.status).toBe(200);

      // Now disable registration
      globalThis.__registrationDisabled = true;

      // Existing user should still succeed
      const response = await provision(token);
      expect(response.status).toBe(200);

      const data: any = await response.json();
      expect(data).toHaveProperty('success', true);
    });
  });

  // ── /info endpoint ──

  describe('/info', () => {
    test('should expose registrationDisabled=true when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const response = await fetch(`${testsBaseUrl}/info`);
      expect(response.status).toBe(200);

      const data: any = await response.json();
      expect(data).toHaveProperty('registrationDisabled', true);
    });

    test('should expose registrationDisabled=false when not disabled', async () => {
      const response = await fetch(`${testsBaseUrl}/info`);
      expect(response.status).toBe(200);

      const data: any = await response.json();
      expect(data).toHaveProperty('registrationDisabled', false);
    });
  });
});
