/**
 * POST /auth/logout — server-side session revocation over HTTP.
 *
 * Same grafting as refresh.test.ts: the preloaded auth mock has no
 * `revokeSession` (that is what the supabase backend looks like), so the
 * local-backend cases borrow the REAL `localAuthBackend` methods for the
 * duration of a test and exercise real HS256 tokens against real
 * `local_auth_sessions` rows.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { DisconnectCode } from '@pulse/shared';
import { createTestUser } from '../../__tests__/fixtures';
import { testsBaseUrl } from '../../__tests__/setup';
import { authBackend } from '../../utils/auth';
import { localAuthBackend } from '../../utils/auth/local';
import { registerSessionSocket } from '../../utils/session-registry';
import { _resetAll } from '../rate-limit-core';

const AUTH_SECRET = 'test-logout-secret-at-least-32-chars-long!!';

const logout = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${testsBaseUrl}/auth/logout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

const refresh = (refreshToken: string) =>
  fetch(`${testsBaseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

type Grafted = {
  refreshSession?: typeof localAuthBackend.refreshSession;
  revokeSession?: typeof localAuthBackend.revokeSession;
};

const useLocalSessions = () => {
  (authBackend as Grafted).refreshSession = localAuthBackend.refreshSession;
  (authBackend as Grafted).revokeSession = localAuthBackend.revokeSession;
};

/** A real local-auth account + matching app user; returns its first session. */
const signUp = async (label: string) => {
  const email = `${label}-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await localAuthBackend.createUser({ email, password: 'hunter2-strong' });
  expect(created.error).toBeNull();
  const authId = created.data.user!.id;
  const userId = await createTestUser({ supabaseId: authId });
  const signIn = async () => {
    const signed = await localAuthBackend.signInWithPassword({ email, password: 'hunter2-strong' });
    expect(signed.error).toBeNull();
    return signed.data.session!;
  };
  return { authId, userId, session: await signIn(), signIn };
};

describe('POST /auth/logout', () => {
  let prevSecret: string | undefined;

  beforeEach(() => {
    prevSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = AUTH_SECRET;
    _resetAll();
  });

  afterEach(() => {
    delete (authBackend as Grafted).refreshSession;
    delete (authBackend as Grafted).revokeSession;
    if (prevSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prevSecret;
  });

  test('is 404 when the auth backend has no revokeSession (supabase mode)', async () => {
    const res = await logout({ refreshToken: 'anything' });
    expect(res.status).toBe(404);
  });

  test('revokes the family named by the refresh token: the next refresh is 401', async () => {
    useLocalSessions();
    const { session } = await signUp('body');

    const res = await logout({ refreshToken: session.refresh_token });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ success: true });

    expect((await refresh(session.refresh_token)).status).toBe(401);
    expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();
  });

  test('revokes the family named by a bearer access token', async () => {
    useLocalSessions();
    const { session } = await signUp('bearer');

    const res = await logout({}, { Authorization: `Bearer ${session.access_token}` });
    expect(res.status).toBe(200);

    expect((await localAuthBackend.getUser(session.access_token)).data.user).toBeNull();
    expect((await refresh(session.refresh_token)).status).toBe(401);
  });

  test('leaves the account’s other sessions alone', async () => {
    useLocalSessions();
    const { session, signIn } = await signUp('others');
    const other = await signIn();

    expect((await logout({ refreshToken: session.refresh_token })).status).toBe(200);

    expect((await localAuthBackend.getUser(other.access_token)).data.user).not.toBeNull();
    expect((await refresh(other.refresh_token)).status).toBe(200);
  });

  test('is 200 for garbage, unknown and missing tokens (no oracle)', async () => {
    useLocalSessions();
    expect((await logout({ refreshToken: 'not-a-jwt' })).status).toBe(200);
    expect((await logout({}, { Authorization: 'Bearer not-a-jwt' })).status).toBe(200);
    expect((await logout({})).status).toBe(200);
    expect((await logout(undefined)).status).toBe(200);
  });

  test('rejects an oversized refresh token with 400', async () => {
    useLocalSessions();
    expect((await logout({ refreshToken: 'x'.repeat(4097) })).status).toBe(400);
  });

  test('closes the live sockets of the revoked family and no others', async () => {
    useLocalSessions();
    const { userId, session, signIn } = await signUp('sockets');
    const other = await signIn();

    const closedMine = mock((_code: number, _reason: string) => {});
    const closedOther = mock((_code: number, _reason: string) => {});
    const unregisterMine = registerSessionSocket(userId, session.access_token, closedMine);
    const unregisterOther = registerSessionSocket(userId, other.access_token, closedOther);

    try {
      expect((await logout({ refreshToken: session.refresh_token })).status).toBe(200);

      expect(closedMine).toHaveBeenCalledTimes(1);
      expect(closedMine.mock.calls[0]?.[0]).toBe(DisconnectCode.SESSION_REVOKED);
      expect(closedOther).not.toHaveBeenCalled();
    } finally {
      unregisterMine();
      unregisterOther();
    }
  });
});
