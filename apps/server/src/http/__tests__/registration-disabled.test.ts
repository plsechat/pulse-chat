import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { login } from '../../__tests__/helpers';
import { provision } from '../../__tests__/fixtures';
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

      const data = (await response.json()) as { errors: Record<string, string> };
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

      const data = (await response.json()) as { errors: Record<string, string> };
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

      const data = (await response.json()) as { errors: Record<string, string> };
      expect(data).toHaveProperty('success', true);
    });
  });

  // ── /login endpoint (auto-registration path) ──

  describe('/login', () => {
    test('should block auto-registration for new users when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const response = await login('newlogin@pulse.local', 'password123');

      expect(response.status).toBe(400);

      const data = (await response.json()) as { errors: Record<string, string> };
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

      const data = (await response.json()) as { errors: Record<string, string> };
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

      const data = (await response.json()) as { errors: Record<string, string> };
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

      const data = (await response.json()) as { errors: Record<string, string> };
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

      const data = (await response.json()) as { errors: Record<string, string> };
      expect(data).toHaveProperty('success', true);
    });
  });

  // ── /info endpoint ──

  describe('/info', () => {
    test('should expose registrationDisabled=true when disabled', async () => {
      globalThis.__registrationDisabled = true;

      const response = await fetch(`${testsBaseUrl}/info`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as { errors: Record<string, string> };
      expect(data).toHaveProperty('registrationDisabled', true);
    });

    test('should expose registrationDisabled=false when not disabled', async () => {
      const response = await fetch(`${testsBaseUrl}/info`);
      expect(response.status).toBe(200);

      const data = (await response.json()) as { errors: Record<string, string> };
      expect(data).toHaveProperty('registrationDisabled', false);
    });
  });
});

// ── Invite consumption is atomic and compensated ──
//
// Every signup entry point consumes an invite through the single
// conditional UPDATE in db/queries/invites.ts. Two racing signups for the
// last use of a maxUses invite must not both pass, and a signup that
// consumed a use but then failed to create the account must hand it back.
describe('invite consumption', () => {
  const makeInvite = async (code: string, maxUses: number) => {
    await getTestDb()
      .insert(invites)
      .values({
        code,
        creatorId: 1,
        serverId: 1,
        maxUses,
        uses: 0,
        expiresAt: Date.now() + 86400000,
        createdAt: Date.now()
      });
  };

  const usesOf = async (code: string) => {
    const [row] = await getTestDb()
      .select({ uses: invites.uses })
      .from(invites)
      .where(eq(invites.code, code))
      .limit(1);
    return row?.uses;
  };

  test('two concurrent social provisions with a maxUses=1 invite — exactly one wins', async () => {
    globalThis.__registrationDisabled = true;
    await makeInvite('RACE-ONE-USE', 1);

    // The auth mock resolves any bearer token to an identity with that id,
    // so two distinct tokens are two distinct brand-new social users.
    const [a, b] = await Promise.all([
      provision('social-race-a', { invite: 'RACE-ONE-USE' }),
      provision('social-race-b', { invite: 'RACE-ONE-USE' })
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(await usesOf('RACE-ONE-USE')).toBe(1);
  });

  test('register with an already-registered e-mail leaves the invite use count unchanged', async () => {
    globalThis.__registrationDisabled = true;
    await makeInvite('REG-EMAIL-TAKEN', 5);

    const first = await register({
      email: 'taken-email@pulse.local',
      password: 'password123',
      displayName: 'Taken Email One',
      invite: 'REG-EMAIL-TAKEN'
    });
    expect(first.status).toBe(200);
    expect(await usesOf('REG-EMAIL-TAKEN')).toBe(1);

    const second = await register({
      email: 'taken-email@pulse.local',
      password: 'password456',
      displayName: 'Taken Email Two',
      invite: 'REG-EMAIL-TAKEN'
    });
    expect(second.status).toBe(400);
    const data = (await second.json()) as { errors: Record<string, string> };
    expect(data.errors.email).toContain('already exists');

    // The failed attempt handed its use back.
    expect(await usesOf('REG-EMAIL-TAKEN')).toBe(1);
  });

  test('a single-use invite survives a failed registration and still admits the next one', async () => {
    // Occupy the e-mail while self-registration is still open …
    const occupant = await register({
      email: 'occupant@pulse.local',
      password: 'password123',
      displayName: 'Occupant'
    });
    expect(occupant.status).toBe(200);

    // … then lock registration down to invites only.
    globalThis.__registrationDisabled = true;
    await makeInvite('SINGLE-USE-RETRY', 1);

    const failed = await register({
      email: 'occupant@pulse.local',
      password: 'password123',
      displayName: 'Occupant Two',
      invite: 'SINGLE-USE-RETRY'
    });
    expect(failed.status).toBe(400);
    expect(await usesOf('SINGLE-USE-RETRY')).toBe(0);

    const retry = await register({
      email: 'retry@pulse.local',
      password: 'password123',
      displayName: 'Retry User',
      invite: 'SINGLE-USE-RETRY'
    });
    expect(retry.status).toBe(200);
    expect(await usesOf('SINGLE-USE-RETRY')).toBe(1);
  });
});

// ── Password policy + e-mail normalisation on /register ──
describe('/register input policy', () => {
  test('rejects passwords shorter than 8 characters', async () => {
    const response = await register({
      email: 'shortpw@pulse.local',
      password: 'abc1234',
      displayName: 'Short PW'
    });

    expect(response.status).toBe(400);
    const data = (await response.json()) as { errors: Record<string, string> };
    expect(data.errors.password).toContain('8');

    const ok = await register({
      email: 'okpw@pulse.local',
      password: 'abc12345',
      displayName: 'OK PW'
    });
    expect(ok.status).toBe(200);
  });

  test('normalises the e-mail: Mixed@Case registers and logs in as lower-case', async () => {
    const response = await register({
      email: '  Mixed.Case@Pulse.LOCAL ',
      password: 'password123',
      displayName: 'Mixed Case'
    });
    expect(response.status).toBe(200);

    // The auth store is keyed by the e-mail the backend received.
    expect(globalThis.__supabaseAuthStore.has('mixed.case@pulse.local')).toBe(true);
    expect(globalThis.__supabaseAuthStore.has('  Mixed.Case@Pulse.LOCAL ')).toBe(false);

    const signedIn = await login('MIXED.CASE@pulse.local', 'password123');
    expect(signedIn.status).toBe(200);
  });
});
