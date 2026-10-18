/**
 * Local auth backend — round-trip + edge-case tests.
 *
 * These tests bypass the global `../utils/auth` mock (set up in
 * `mock-modules.ts`) by importing the concrete `localAuthBackend`
 * directly from `../local`. The DB is real (test fixture).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { and, eq, isNull } from 'drizzle-orm';
import { decodeJwt, SignJWT } from 'jose';
import {
  localAuthBackend,
  REFRESH_REUSE_GRACE_MS,
  resetSessionRevocationCache
} from '../local';
import { initTest } from '../../../__tests__/helpers';
import { getTestDb } from '../../../__tests__/mock-db';
import { localAuthSessions } from '../../../db/schema';

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

// --- sessions: rotation, reuse detection, revocation ---

/** A fresh local-auth account signed in once; returns ids + the pair. */
const signUp = async (label: string) => {
  const email = uniqueEmail(label);
  const created = await localAuthBackend.createUser({
    email,
    password: 'hunter2-strong'
  });
  expect(created.error).toBeNull();
  const signed = await localAuthBackend.signInWithPassword({
    email,
    password: 'hunter2-strong'
  });
  expect(signed.error).toBeNull();
  return { email, authId: created.data.user!.id, session: signed.data.session! };
};

const familyOf = (token: string) => decodeJwt(token).sid as string;

/** Push a refresh row's revocation back past the reuse grace window. */
const ageRevocation = async (refreshToken: string) => {
  const jti = decodeJwt(refreshToken).jti!;
  await getTestDb()
    .update(localAuthSessions)
    .set({ revokedAt: Date.now() - REFRESH_REUSE_GRACE_MS - 1000 })
    .where(eq(localAuthSessions.id, jti));
};

const liveRowsOfFamily = async (familyId: string) =>
  getTestDb()
    .select({ id: localAuthSessions.id })
    .from(localAuthSessions)
    .where(
      and(
        eq(localAuthSessions.familyId, familyId),
        isNull(localAuthSessions.revokedAt)
      )
    );

describe('localAuthBackend sessions', () => {
  test('a sign-in mints a 15-minute access token and a 30-day refresh token sharing one family', async () => {
    await initTest(1);
    const { authId, session } = await signUp('ttl');

    const access = decodeJwt(session.access_token);
    const refresh = decodeJwt(session.refresh_token);
    const nowSec = Math.floor(Date.now() / 1000);

    expect(access.exp! - nowSec).toBeGreaterThan(15 * 60 - 5);
    expect(access.exp! - nowSec).toBeLessThanOrEqual(15 * 60);
    expect(refresh.exp! - nowSec).toBeGreaterThan(30 * 24 * 60 * 60 - 5);

    expect(typeof access.sid).toBe('string');
    expect(refresh.sid).toBe(access.sid);
    expect(access.jti).not.toBe(refresh.jti);

    // The refresh token's jti is the session row; the family is live.
    const [row] = await getTestDb()
      .select()
      .from(localAuthSessions)
      .where(eq(localAuthSessions.id, refresh.jti!));
    expect(row?.userId).toBe(authId);
    expect(row?.familyId).toBe(access.sid as string);
    expect(row?.revokedAt).toBeNull();
    expect(row?.replacedBy).toBeNull();
  });

  test('refresh retires the used token: it is rejected once the race window has passed', async () => {
    await initTest(1);
    const { session } = await signUp('retire');

    const rotated = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(rotated.error).toBeNull();
    expect(familyOf(rotated.data.session!.refresh_token)).toBe(
      familyOf(session.refresh_token)
    );

    const [parent] = await getTestDb()
      .select()
      .from(localAuthSessions)
      .where(eq(localAuthSessions.id, decodeJwt(session.refresh_token).jti!));
    expect(parent?.revokedAt).not.toBeNull();
    expect(parent?.replacedBy).toBe(decodeJwt(rotated.data.session!.refresh_token).jti!);

    await ageRevocation(session.refresh_token);
    const reused = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(reused.data.session).toBeNull();
    expect(reused.error?.reason).toBe('invalid_credentials');
  });

  test('a reuse inside the race window gets its own pair and keeps the family alive', async () => {
    await initTest(1);
    const { authId, session } = await signUp('race');
    const family = familyOf(session.refresh_token);

    const first = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(first.error).toBeNull();
    // Second tab: same (now retired) refresh token, seconds later.
    const second = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(second.error).toBeNull();
    expect(second.data.session!.refresh_token).not.toBe(
      first.data.session!.refresh_token
    );
    expect(familyOf(second.data.session!.access_token)).toBe(family);

    // Both tabs keep working, nothing was revoked.
    for (const pair of [first.data.session!, second.data.session!]) {
      const verified = await localAuthBackend.getUser(pair.access_token);
      expect(verified.data.user?.id).toBe(authId);
    }
    expect((await liveRowsOfFamily(family)).length).toBe(2);
  });

  test('a reuse after the race window revokes the whole family, current pair included', async () => {
    await initTest(1);
    const { session } = await signUp('replay');
    const family = familyOf(session.refresh_token);

    const current = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(current.error).toBeNull();
    expect(
      (await localAuthBackend.getUser(current.data.session!.access_token)).data.user
    ).not.toBeNull();

    await ageRevocation(session.refresh_token);
    const replay = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(replay.error?.reason).toBe('invalid_credentials');

    // The legitimate holder's pair died with the family.
    expect((await liveRowsOfFamily(family)).length).toBe(0);
    expect(
      (await localAuthBackend.getUser(current.data.session!.access_token)).data.user
    ).toBeNull();
    const again = await localAuthBackend.refreshSession!(
      current.data.session!.refresh_token
    );
    expect(again.error?.reason).toBe('invalid_credentials');
  });

  test('revokeSession by access token ends the family', async () => {
    await initTest(1);
    const { session } = await signUp('revoke-access');

    await localAuthBackend.revokeSession!({ accessToken: session.access_token });

    expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();
    const refreshed = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(refreshed.error?.reason).toBe('invalid_credentials');
    expect((await liveRowsOfFamily(familyOf(session.access_token))).length).toBe(0);
  });

  test('revokeSession by refresh token ends the family, even with an expired access token', async () => {
    await initTest(1);
    const { session } = await signUp('revoke-refresh');

    await localAuthBackend.revokeSession!({ refreshToken: session.refresh_token });

    expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();
    const refreshed = await localAuthBackend.refreshSession!(session.refresh_token);
    expect(refreshed.error?.reason).toBe('invalid_credentials');
  });

  test('revokeSession accepts an expired access token as proof of the family', async () => {
    await initTest(1);
    const { authId, session } = await signUp('revoke-expired');
    const family = familyOf(session.access_token);

    // Same signing, same family, already expired — getUser refuses it,
    // revokeSession still learns the family from it.
    const expired = await new SignJWT({ typ: 'access', sid: family })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(authId)
      .setIssuer('pulse:local-auth')
      .setJti(randomUUIDv7())
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(TEST_SECRET));
    expect((await localAuthBackend.getUser(expired)).data.user).toBeNull();

    await localAuthBackend.revokeSession!({ accessToken: expired });
    expect((await liveRowsOfFamily(family)).length).toBe(0);
    expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();
  });

  test('revokeSession ignores garbage and tokens from another secret', async () => {
    await initTest(1);
    const { session } = await signUp('revoke-garbage');

    await localAuthBackend.revokeSession!({ refreshToken: 'not-a-jwt' });
    await localAuthBackend.revokeSession!({ accessToken: '' });
    await localAuthBackend.revokeSession!({});

    const forged = await new SignJWT({ typ: 'refresh', sid: familyOf(session.refresh_token) })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(decodeJwt(session.refresh_token).sub!)
      .setIssuer('pulse:local-auth')
      .setJti(decodeJwt(session.refresh_token).jti!)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode('totally-different-secret-still-32-chars-long'));
    await localAuthBackend.revokeSession!({ refreshToken: forged });

    // Nothing above touched the real session.
    expect((await localAuthBackend.getUser(session.access_token)).data.user).not.toBeNull();
  });

  test('revokeAllSessions signs every family out except the one it is told to keep', async () => {
    await initTest(1);
    const { email, authId, session: keep } = await signUp('revoke-all');
    const other = (
      await localAuthBackend.signInWithPassword({ email, password: 'hunter2-strong' })
    ).data.session!;
    const third = (
      await localAuthBackend.signInWithPassword({ email, password: 'hunter2-strong' })
    ).data.session!;

    await localAuthBackend.revokeAllSessions!(authId, {
      exceptFamilyId: familyOf(keep.access_token)
    });

    expect((await localAuthBackend.getUser(keep.access_token)).data.user?.id).toBe(authId);
    expect((await localAuthBackend.refreshSession!(keep.refresh_token)).error).toBeNull();

    for (const dead of [other, third]) {
      expect((await localAuthBackend.getUser(dead.access_token)).data.user).toBeNull();
      expect(
        (await localAuthBackend.refreshSession!(dead.refresh_token)).error?.reason
      ).toBe('invalid_credentials');
    }

    // Without an exception everything goes, including the kept one.
    await localAuthBackend.revokeAllSessions!(authId);
    expect((await localAuthBackend.getUser(keep.access_token)).data.user).toBeNull();
  });

  test('getUser rejects a revoked family through the cache and after a cold start', async () => {
    await initTest(1);
    const { authId, session } = await signUp('cold');
    const family = familyOf(session.access_token);

    // Warm the cache with an "alive" answer, then revoke in the DB only
    // (as a sweep in another process, or a restart, would leave it):
    // the in-process revocation must flip the entry at once …
    expect((await localAuthBackend.getUser(session.access_token)).data.user?.id).toBe(authId);
    await localAuthBackend.revokeSession!({ accessToken: session.access_token });
    expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();

    // … and with no cache at all the DB row decides.
    resetSessionRevocationCache();
    expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();

    // A family whose rows were removed entirely counts as revoked too.
    const { session: swept } = await signUp('swept');
    expect((await localAuthBackend.getUser(swept.access_token)).data.user).not.toBeNull();
    await getTestDb()
      .delete(localAuthSessions)
      .where(eq(localAuthSessions.familyId, familyOf(swept.access_token)));
    resetSessionRevocationCache();
    expect((await localAuthBackend.getUser(swept.access_token)).data.user).toBeNull();
    expect(family).not.toBe(familyOf(swept.access_token));
  });

  test('a cached "alive" answer is re-read after its TTL, so an external revocation lands', async () => {
    await initTest(1);
    const { authId, session } = await signUp('ttl-cache');

    expect((await localAuthBackend.getUser(session.access_token)).data.user?.id).toBe(authId);
    // Revoke behind the cache's back (direct DB write, no in-process mark).
    await getTestDb()
      .update(localAuthSessions)
      .set({ revokedAt: Date.now() })
      .where(eq(localAuthSessions.familyId, familyOf(session.access_token)));
    // Still cached as alive …
    expect((await localAuthBackend.getUser(session.access_token)).data.user?.id).toBe(authId);

    // … until the TTL passes.
    const realNow = Date.now;
    const nowSpy = spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000);
    try {
      expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('deleting the auth user removes its session rows', async () => {
    await initTest(1);
    const { authId, session } = await signUp('cascade');
    expect((await liveRowsOfFamily(familyOf(session.access_token))).length).toBe(1);

    await localAuthBackend.deleteUserById(authId);

    const rows = await getTestDb()
      .select()
      .from(localAuthSessions)
      .where(eq(localAuthSessions.userId, authId));
    expect(rows.length).toBe(0);
  });
});
