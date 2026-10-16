/**
 * POST /auth/refresh — local-backend token rotation over HTTP.
 *
 * The preloaded auth mock (mock-modules.ts) has no `refreshSession`, which
 * is exactly what the supabase backend looks like to this route. For the
 * local-backend cases the tests graft the REAL `localAuthBackend.refreshSession`
 * onto the mock for the duration of the test, so the route exercises real
 * HS256 verification against `local_auth_users` rows.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { decodeJwt, SignJWT } from 'jose';
import { createTestUser } from '../../__tests__/fixtures';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { localAuthSessions, users } from '../../db/schema';
import { authBackend } from '../../utils/auth';
import { localAuthBackend, REFRESH_REUSE_GRACE_MS } from '../../utils/auth/local';
import { _resetAll } from '../rate-limit-core';

const AUTH_SECRET = 'test-refresh-secret-at-least-32-chars-long!!';

const refresh = (refreshToken: unknown) =>
  fetch(`${testsBaseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

type Grafted = { refreshSession?: typeof localAuthBackend.refreshSession };

const useLocalRefresh = () => {
  (authBackend as Grafted).refreshSession = localAuthBackend.refreshSession;
};

/** A real local-auth account + matching app user; returns its first session. */
const signUp = async (label: string) => {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await localAuthBackend.createUser({ email, password: 'hunter2-strong' });
  expect(created.error).toBeNull();
  const authId = created.data.user!.id;
  const userId = await createTestUser({ supabaseId: authId });
  const signed = await localAuthBackend.signInWithPassword({ email, password: 'hunter2-strong' });
  expect(signed.error).toBeNull();
  return { authId, userId, session: signed.data.session! };
};

describe('POST /auth/refresh', () => {
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = AUTH_SECRET;
    // /auth/refresh shares the per-IP auth budget (10 per window); the
    // file sends more than that from 127.0.0.1.
    _resetAll();
  });

  afterEach(() => {
    delete (authBackend as Grafted).refreshSession;
    if (prevSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prevSecret;
  });

  test('is 404 when the auth backend has no refreshSession (supabase mode)', async () => {
    const res = await refresh('anything');
    expect(res.status).toBe(404);
  });

  test('issues a fresh, rotated pair for a valid refresh token', async () => {
    useLocalRefresh();
    const { session, userId } = await signUp('rotate');

    const res = await refresh(session.refresh_token);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      success: boolean;
      accessToken: string;
      refreshToken: string;
    };
    expect(data.success).toBe(true);
    expect(data.accessToken).toBeTruthy();
    expect(data.refreshToken).toBeTruthy();
    expect(data.accessToken).not.toBe(session.access_token);
    expect(data.refreshToken).not.toBe(session.refresh_token);

    // The new access token is a real session for that account …
    const verified = await localAuthBackend.getUser(data.accessToken);
    expect(verified.data.user?.id).toBe(
      (await getTestDb().select({ supabaseId: users.supabaseId }).from(users).where(eq(users.id, userId)).limit(1))[0]!.supabaseId
    );
    // … and the new refresh token is NOT usable as one.
    const asAccess = await localAuthBackend.getUser(data.refreshToken);
    expect(asAccess.data.user).toBeNull();
  });

  test('rejects a tampered refresh token', async () => {
    useLocalRefresh();
    const { session } = await signUp('tamper');

    const [header, payload, signature] = session.refresh_token.split('.');
    // Flip a character in the middle of the signature. The LAST base64url
    // character carries two padding bits, so changing only it can decode
    // to the very same bytes and still verify.
    const at = 10;
    const replacement = signature![at] === 'A' ? 'B' : 'A';
    const flipped = `${signature!.slice(0, at)}${replacement}${signature!.slice(at + 1)}`;

    const res = await refresh(`${header}.${payload}.${flipped}`);
    expect(res.status).toBe(401);
  });

  test('rejects an expired refresh token', async () => {
    useLocalRefresh();
    const { authId } = await signUp('expired');

    const expired = await new SignJWT({ typ: 'refresh' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(authId)
      .setIssuer('pulse:local-auth')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(new TextEncoder().encode(AUTH_SECRET));

    const res = await refresh(expired);
    expect(res.status).toBe(401);
  });

  test('rejects a refresh token that was already rotated (reuse) and kills the current pair', async () => {
    useLocalRefresh();
    const { session } = await signUp('reuse');

    const first = await refresh(session.refresh_token);
    expect(first.status).toBe(200);
    const current = (await first.json()) as { accessToken: string; refreshToken: string };

    // Past the two-tabs race window the old token is a replay.
    await getTestDb()
      .update(localAuthSessions)
      .set({ revokedAt: Date.now() - REFRESH_REUSE_GRACE_MS - 1000 })
      .where(eq(localAuthSessions.id, decodeJwt(session.refresh_token).jti!));

    const replay = await refresh(session.refresh_token);
    expect(replay.status).toBe(401);

    // Whoever holds the rotated pair is signed out too.
    expect((await refresh(current.refreshToken)).status).toBe(401);
    expect((await localAuthBackend.getUser(current.accessToken)).data.user).toBeNull();
  });

  test('rejects an access token presented as a refresh token', async () => {
    useLocalRefresh();
    const { session } = await signUp('typ');

    const res = await refresh(session.access_token);
    expect(res.status).toBe(401);
  });

  test('rejects garbage and missing tokens', async () => {
    useLocalRefresh();
    expect((await refresh('not-a-jwt')).status).toBe(401);
    expect((await refresh('')).status).toBe(400);
    expect((await refresh(undefined)).status).toBe(400);
  });

  test('is 401 when the auth account no longer maps to an app user', async () => {
    useLocalRefresh();
    const { session, userId } = await signUp('orphan');
    await getTestDb().delete(users).where(eq(users.id, userId));

    const res = await refresh(session.refresh_token);
    expect(res.status).toBe(401);
  });

  test('is 403 for a banned account', async () => {
    useLocalRefresh();
    const { session, userId } = await signUp('banned');
    await getTestDb()
      .update(users)
      .set({ banned: true, banReason: 'spam' })
      .where(eq(users.id, userId));

    const res = await refresh(session.refresh_token);
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain('banned');
  });
});
