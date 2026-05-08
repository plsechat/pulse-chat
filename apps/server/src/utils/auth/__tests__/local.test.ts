/**
 * Local auth backend — round-trip + edge-case tests.
 *
 * These tests bypass the global `../utils/auth` mock (set up in
 * `mock-modules.ts`) by importing the concrete `localAuthBackend`
 * directly from `../local`. The DB is real (test fixture).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SignJWT } from 'jose';
import { localAuthBackend } from '../local';
import { initTest } from '../../../__tests__/helpers';

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

    const created = await localAuthBackend.createUser({
      email: 'roundtrip@example.com',
      password: 'hunter2-strong'
    });
    expect(created.error).toBeNull();
    expect(created.data.user?.email).toBe('roundtrip@example.com');

    const signed = await localAuthBackend.signInWithPassword({
      email: 'roundtrip@example.com',
      password: 'hunter2-strong'
    });
    expect(signed.error).toBeNull();
    expect(signed.data.session?.access_token).toBeTruthy();
    expect(signed.data.user?.id).toBe(created.data.user!.id);

    const verified = await localAuthBackend.getUser(
      signed.data.session!.access_token
    );
    expect(verified.data.user?.id).toBe(created.data.user!.id);
    expect(verified.data.user?.email).toBe('roundtrip@example.com');
    expect(verified.data.user?.identities).toEqual([{ provider: 'email' }]);
  });

  test('signInWithPassword rejects the wrong password', async () => {
    await initTest(1);

    await localAuthBackend.createUser({
      email: 'wrongpw@example.com',
      password: 'correct-horse-battery-staple'
    });

    const result = await localAuthBackend.signInWithPassword({
      email: 'wrongpw@example.com',
      password: 'definitely-not-it'
    });

    expect(result.data.user).toBeNull();
    expect(result.data.session).toBeNull();
    expect(result.error?.reason).toBe('invalid_credentials');
  });

  test('signInWithPassword rejects an unknown email with the same canonical reason', async () => {
    await initTest(1);

    const result = await localAuthBackend.signInWithPassword({
      email: 'no-such-user@example.com',
      password: 'whatever'
    });

    // Same reason for unknown email and wrong password — don't leak
    // which case the caller hit.
    expect(result.error?.reason).toBe('invalid_credentials');
  });

  test('createUser is rejected when the email is already registered', async () => {
    await initTest(1);

    await localAuthBackend.createUser({
      email: 'duplicate@example.com',
      password: 'pw1234567'
    });

    const second = await localAuthBackend.createUser({
      email: 'duplicate@example.com',
      password: 'a-different-pw'
    });
    expect(second.data.user).toBeNull();
    expect(second.error?.reason).toBe('user_already_exists');
  });

  test('updateUserById changes the password — old password stops working', async () => {
    await initTest(1);

    const created = await localAuthBackend.createUser({
      email: 'rotate@example.com',
      password: 'old-password-hunter'
    });
    expect(created.data.user).not.toBeNull();

    const updated = await localAuthBackend.updateUserById(
      created.data.user!.id,
      { password: 'fresh-password-victor' }
    );
    expect(updated.error).toBeNull();

    const oldFails = await localAuthBackend.signInWithPassword({
      email: 'rotate@example.com',
      password: 'old-password-hunter'
    });
    expect(oldFails.error?.reason).toBe('invalid_credentials');

    const newWorks = await localAuthBackend.signInWithPassword({
      email: 'rotate@example.com',
      password: 'fresh-password-victor'
    });
    expect(newWorks.error).toBeNull();
    expect(newWorks.data.session?.access_token).toBeTruthy();
  });

  test('getUser rejects a token signed with a different secret', async () => {
    await initTest(1);

    const created = await localAuthBackend.createUser({
      email: 'foreign-sig@example.com',
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

    const created = await localAuthBackend.createUser({
      email: 'lookup@example.com',
      password: 'hunter2-strong'
    });

    const found = await localAuthBackend.getUserById(created.data.user!.id);
    expect(found.error).toBeNull();
    expect(found.data.user?.email).toBe('lookup@example.com');
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
});
