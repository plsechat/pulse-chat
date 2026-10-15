/**
 * Local auth backend — round-trip + edge-case tests.
 *
 * These tests bypass the global `../utils/auth` mock (set up in
 * `mock-modules.ts`) by importing the concrete `localAuthBackend`
 * directly from `../local`. The DB is real (test fixture).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { SignJWT } from 'jose';
import { localAuthBackend } from '../local';
import { initTest } from '../../../__tests__/helpers';

// `local_auth_users` is reset between tests, but a hard-coded address
// would still collide with a row left by a crashed previous run against
// the same database. Unique per test keeps createUser deterministic.
const uniqueEmail = (label: string) =>
  `${label}-${randomUUIDv7().slice(0, 8)}@example.com`;

const TEST_SECRET = 'test-secret-min-32-chars-must-be-this-or-longer';

beforeAll(() => {
  // local.ts reads process.env.AUTH_SECRET on every signing call,
  // so setting it here is enough — no module re-import needed.
  process.env.AUTH_SECRET = TEST_SECRET;
});

afterAll(() => {
  delete process.env.AUTH_SECRET;
});

describe('localAuthBackend', () => {
  test('createUser → signInWithPassword → getUser round-trip', async () => {
    await initTest(1);
    const email = uniqueEmail('roundtrip');

    const created = await localAuthBackend.createUser({
      email: email,
      password: 'hunter2-strong'
    });
    expect(created.error).toBeNull();
    expect(created.data.user?.email).toBe(email);

    const signed = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'hunter2-strong'
    });
    expect(signed.error).toBeNull();
    expect(signed.data.session?.access_token).toBeTruthy();
    expect(signed.data.user?.id).toBe(created.data.user!.id);

    const verified = await localAuthBackend.getUser(
      signed.data.session!.access_token
    );
    expect(verified.data.user?.id).toBe(created.data.user!.id);
    expect(verified.data.user?.email).toBe(email);
    expect(verified.data.user?.identities).toEqual([{ provider: 'email' }]);
  });

  test('signInWithPassword rejects the wrong password', async () => {
    await initTest(1);
    const email = uniqueEmail('wrongpw');

    await localAuthBackend.createUser({
      email: email,
      password: 'correct-horse-battery-staple'
    });

    const result = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'definitely-not-it'
    });

    expect(result.data.user).toBeNull();
    expect(result.data.session).toBeNull();
    expect(result.error?.reason).toBe('invalid_credentials');
  });

  test('signInWithPassword rejects an unknown email with the same canonical reason', async () => {
    await initTest(1);
    const email = uniqueEmail('no-such-user');

    const result = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'whatever'
    });

    // Same reason for unknown email and wrong password — don't leak
    // which case the caller hit.
    expect(result.error?.reason).toBe('invalid_credentials');
  });

  test('createUser is rejected when the email is already registered', async () => {
    await initTest(1);
    const email = uniqueEmail('duplicate');

    await localAuthBackend.createUser({
      email: email,
      password: 'pw1234567'
    });

    const second = await localAuthBackend.createUser({
      email: email,
      password: 'a-different-pw'
    });
    expect(second.data.user).toBeNull();
    expect(second.error?.reason).toBe('user_already_exists');
  });

  test('updateUserById changes the password — old password stops working', async () => {
    await initTest(1);
    const email = uniqueEmail('rotate');

    const created = await localAuthBackend.createUser({
      email: email,
      password: 'old-password-hunter'
    });
    expect(created.data.user).not.toBeNull();

    const updated = await localAuthBackend.updateUserById(
      created.data.user!.id,
      { password: 'fresh-password-victor' }
    );
    expect(updated.error).toBeNull();

    const oldFails = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'old-password-hunter'
    });
    expect(oldFails.error?.reason).toBe('invalid_credentials');

    const newWorks = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'fresh-password-victor'
    });
    expect(newWorks.error).toBeNull();
    expect(newWorks.data.session?.access_token).toBeTruthy();
  });

  test('getUser rejects a token signed with a different secret', async () => {
    await initTest(1);
    const email = uniqueEmail('foreign-sig');

    const created = await localAuthBackend.createUser({
      email: email,
      password: 'hunter2-strong'
    });
    expect(created.data.user).not.toBeNull();

    // Sign a JWT with the right shape but a different key — mimics an
    // attacker forging a token without knowing AUTH_SECRET.
    const wrongKey = new TextEncoder().encode(
      'totally-different-secret-still-32-chars-long'
    );
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(created.data.user!.id)
      .setIssuer('pulse:local-auth')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(wrongKey);

    const result = await localAuthBackend.getUser(forged);
    expect(result.data.user).toBeNull();
  });

  test('getUser rejects garbage that is not even a token', async () => {
    await initTest(1);
    const result = await localAuthBackend.getUser('definitely-not-a-jwt');
    expect(result.data.user).toBeNull();
  });

  test('getUserById returns the user with email + identities', async () => {
    await initTest(1);
    const email = uniqueEmail('lookup');

    const created = await localAuthBackend.createUser({
      email: email,
      password: 'hunter2-strong'
    });

    const found = await localAuthBackend.getUserById(created.data.user!.id);
    expect(found.error).toBeNull();
    expect(found.data.user?.email).toBe(email);
    expect(found.data.user?.identities).toEqual([{ provider: 'email' }]);
  });

  test('getUserById returns user_not_found for an unknown id', async () => {
    await initTest(1);
    const result = await localAuthBackend.getUserById(
      '00000000-0000-0000-0000-000000000000'
    );
    expect(result.data.user).toBeNull();
    expect(result.error?.reason).toBe('user_not_found');
  });

  // --- refreshSession (typed tokens) ---

  test('refreshSession rotates the pair and the new tokens work', async () => {
    await initTest(1);
    const email = uniqueEmail('refresh');

    await localAuthBackend.createUser({
      email: email,
      password: 'hunter2-strong'
    });
    const signed = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'hunter2-strong'
    });
    const session = signed.data.session!;

    const refreshed = await localAuthBackend.refreshSession!(
      session.refresh_token
    );
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session?.access_token).toBeTruthy();
    expect(refreshed.data.session?.refresh_token).toBeTruthy();
    // Rotated: the new refresh token replaces the old one
    expect(refreshed.data.session!.refresh_token).not.toBe(
      session.refresh_token
    );

    // The new access token authenticates
    const verified = await localAuthBackend.getUser(
      refreshed.data.session!.access_token
    );
    expect(verified.data.user?.email).toBe(email);
  });

  test('getUser rejects a refresh token used as an access token', async () => {
    await initTest(1);
    const email = uniqueEmail('typ-access');

    await localAuthBackend.createUser({
      email: email,
      password: 'hunter2-strong'
    });
    const signed = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'hunter2-strong'
    });

    // A refresh token must never work as a session credential
    const result = await localAuthBackend.getUser(
      signed.data.session!.refresh_token
    );
    expect(result.data.user).toBeNull();
  });

  test('refreshSession rejects an access token', async () => {
    await initTest(1);
    const email = uniqueEmail('typ-refresh');

    await localAuthBackend.createUser({
      email: email,
      password: 'hunter2-strong'
    });
    const signed = await localAuthBackend.signInWithPassword({
      email: email,
      password: 'hunter2-strong'
    });

    const result = await localAuthBackend.refreshSession!(
      signed.data.session!.access_token
    );
    expect(result.data.session).toBeNull();
    expect(result.error?.reason).toBe('invalid_credentials');
  });

  test('untyped tokens are rejected by both paths', async () => {
    await initTest(1);
    const email = uniqueEmail('legacy');

    const created = await localAuthBackend.createUser({
      email: email,
      password: 'hunter2-strong'
    });

    // Pre-`typ` token: same signing, no typ claim. The upgrade window
    // that accepted these closed on 2026-08-09.
    const legacyToken = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(created.data.user!.id)
      .setIssuer('pulse:local-auth')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(TEST_SECRET));

    const asAccess = await localAuthBackend.getUser(legacyToken);
    expect(asAccess.data.user).toBeNull();

    const asRefresh = await localAuthBackend.refreshSession!(legacyToken);
    expect(asRefresh.data.session).toBeNull();
    expect(asRefresh.error?.reason).toBe('invalid_credentials');
  });

  test('refreshSession rejects garbage', async () => {
    await initTest(1);
    const result = await localAuthBackend.refreshSession!('not-a-jwt');
    expect(result.data.session).toBeNull();
    expect(result.error?.reason).toBe('invalid_credentials');
  });
});

// --- e-mail normalisation + unknown-e-mail timing ---

describe('localAuthBackend e-mail handling', () => {
  test('createUser stores the e-mail trimmed and lower-cased', async () => {
    await initTest(1);
    const base = uniqueEmail('case');
    const mixed = `  ${base.replace(/^./, (c) => c.toUpperCase()).replace('@example', '@Example')} `;

    const created = await localAuthBackend.createUser({
      email: mixed,
      password: 'hunter2-strong'
    });
    expect(created.error).toBeNull();
    expect(created.data.user?.email).toBe(base);

    const found = await localAuthBackend.getUserById(created.data.user!.id);
    expect(found.data.user?.email).toBe(base);
  });

  test('signInWithPassword matches the e-mail regardless of case or padding', async () => {
    await initTest(1);
    const base = uniqueEmail('login-case');

    await localAuthBackend.createUser({
      email: base.toUpperCase(),
      password: 'hunter2-strong'
    });

    for (const spelling of [base, base.toUpperCase(), ` ${base} `]) {
      const signed = await localAuthBackend.signInWithPassword({
        email: spelling,
        password: 'hunter2-strong'
      });
      expect(signed.error).toBeNull();
      expect(signed.data.user?.email).toBe(base);
    }
  });

  test('createUser treats a differently-cased duplicate as already registered', async () => {
    await initTest(1);
    const base = uniqueEmail('dupe-case');

    const first = await localAuthBackend.createUser({
      email: base,
      password: 'hunter2-strong'
    });
    expect(first.error).toBeNull();

    const second = await localAuthBackend.createUser({
      email: base.toUpperCase(),
      password: 'other-password-1'
    });
    expect(second.data.user).toBeNull();
    expect(second.error?.reason).toBe('user_already_exists');
  });

  test('an unknown e-mail still costs one password verification (no timing tell)', async () => {
    await initTest(1);
    const verify = spyOn(Bun.password, 'verify');
    try {
      const result = await localAuthBackend.signInWithPassword({
        email: uniqueEmail('ghost'),
        password: 'whatever-it-is'
      });
      expect(result.error?.reason).toBe('invalid_credentials');
      expect(verify).toHaveBeenCalledTimes(1);
      // Verified against the static dummy hash, not skipped.
      expect(String(verify.mock.calls[0]?.[1])).toStartWith('$argon2id$');
    } finally {
      verify.mockRestore();
    }
  });
});
