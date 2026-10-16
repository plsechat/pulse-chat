/**
 * users.updatePassword — a changed password signs every OTHER device
 * out. The route asks the auth backend to revoke all session families
 * except the caller's own (the `sid` of the access token the connection
 * authenticated with) and the revoked families lose their sockets.
 *
 * The preloaded auth mock has no sessions; the real local backend's
 * `revokeAllSessions` is grafted onto it for the test and the seeded
 * caller's `users.supabaseId` is pointed at a real local-auth account so
 * the mock (current-password check, password update) and the real
 * session store (families, revocation) describe the same user.
 *
 * Setup is inline per test (no beforeEach) — see delete-account.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { DisconnectCode } from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { decodeJwt } from 'jose';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { users } from '../../db/schema';
import { authBackend } from '../../utils/auth';
import { localAuthBackend } from '../../utils/auth/local';
import { registerSessionSocket } from '../../utils/session-registry';

const AUTH_SECRET = 'test-password-sessions-secret-32-chars-long!!';
const CALLER_ID = 2;
const OLD_PASSWORD = 'old-password-hunter';
const NEW_PASSWORD = 'fresh-password-victor';

type Grafted = { revokeAllSessions?: typeof localAuthBackend.revokeAllSessions };

/** The in-memory auth store the mock backend reads (see mock-modules). */
const authStore = (
  globalThis as unknown as {
    __supabaseAuthStore: Map<
      string,
      { supabaseId: string; password: string; email: string }
    >;
  }
).__supabaseAuthStore;

/**
 * A real local-auth account wired to the seeded caller: the mock store
 * entry drives the route's password challenge, the local backend holds
 * the sessions. Returns a sign-in helper that opens a new family.
 */
const wireCaller = async () => {
  const email = `pw-${crypto.randomUUID().slice(0, 8)}@example.com`;
  const created = await localAuthBackend.createUser({ email, password: OLD_PASSWORD });
  expect(created.error).toBeNull();
  const authId = created.data.user!.id;

  await getTestDb()
    .update(users)
    .set({ supabaseId: authId })
    .where(eq(users.id, CALLER_ID));
  authStore.set(email, { supabaseId: authId, password: OLD_PASSWORD, email });
  (authBackend as Grafted).revokeAllSessions = localAuthBackend.revokeAllSessions;

  const signIn = async () => {
    const signed = await localAuthBackend.signInWithPassword({ email, password: OLD_PASSWORD });
    expect(signed.error).toBeNull();
    return signed.data.session!;
  };
  return { authId, signIn };
};

const familyOf = (token: string) => decodeJwt(token).sid as string;

const waitFor = async (predicate: () => boolean, timeoutMs = 4000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(25);
};

describe('users.updatePassword session revocation', () => {
  let prevSecret: string | undefined;

  beforeAll(() => {
    prevSecret = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = AUTH_SECRET;
  });

  afterAll(() => {
    if (prevSecret === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prevSecret;
  });

  afterEach(() => {
    delete (authBackend as Grafted).revokeAllSessions;
  });

  test('signs every other device out and keeps the caller’s own session', async () => {
    const { authId, signIn } = await wireCaller();
    const mine = await signIn();
    const laptop = await signIn();
    const phone = await signIn();

    const { caller, ctx } = await initTest(CALLER_ID);
    // What createContext derives from a real local access token.
    Object.assign(ctx, { authSessionId: familyOf(mine.access_token) });

    await caller.users.updatePassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmNewPassword: NEW_PASSWORD
    });

    expect((await localAuthBackend.getUser(mine.access_token)).data.user?.id).toBe(authId);
    expect((await localAuthBackend.refreshSession!(mine.refresh_token)).error).toBeNull();

    for (const other of [laptop, phone]) {
      expect((await localAuthBackend.getUser(other.access_token)).data.user).toBeNull();
      expect(
        (await localAuthBackend.refreshSession!(other.refresh_token)).error?.reason
      ).toBe('invalid_credentials');
    }
  });

  test('closes the other devices’ sockets (deferred) and not the caller’s', async () => {
    const { signIn } = await wireCaller();
    const mine = await signIn();
    const laptop = await signIn();

    const closedMine = mock((_code: number, _reason: string) => {});
    const closedLaptop = mock((_code: number, _reason: string) => {});
    const unregisterMine = registerSessionSocket(CALLER_ID, mine.access_token, closedMine);
    const unregisterLaptop = registerSessionSocket(CALLER_ID, laptop.access_token, closedLaptop);

    try {
      const { caller, ctx } = await initTest(CALLER_ID);
      Object.assign(ctx, { authSessionId: familyOf(mine.access_token) });

      await caller.users.updatePassword({
        currentPassword: OLD_PASSWORD,
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD
      });

      // The close is deferred so the mutation's own response can leave
      // first; nothing is closed synchronously.
      expect(closedLaptop).not.toHaveBeenCalled();
      await waitFor(() => closedLaptop.mock.calls.length > 0);

      expect(closedLaptop).toHaveBeenCalledTimes(1);
      expect(closedLaptop.mock.calls[0]?.[0]).toBe(DisconnectCode.SESSION_REVOKED);
      expect(closedMine).not.toHaveBeenCalled();
    } finally {
      unregisterMine();
      unregisterLaptop();
    }
  });

  test('with no session family on the connection every local family is revoked', async () => {
    const { signIn } = await wireCaller();
    const laptop = await signIn();

    // An OIDC session changing the account password: the context has no
    // family claim, so nothing is spared (the OIDC session itself is not
    // a family and keeps working).
    const { caller } = await initTest(CALLER_ID);

    await caller.users.updatePassword({
      currentPassword: OLD_PASSWORD,
      newPassword: NEW_PASSWORD,
      confirmNewPassword: NEW_PASSWORD
    });

    expect((await localAuthBackend.getUser(laptop.access_token)).data.user).toBeNull();
  });

  test('a failed current-password check revokes nothing', async () => {
    const { authId, signIn } = await wireCaller();
    const laptop = await signIn();
    const { caller } = await initTest(CALLER_ID);

    await expect(
      caller.users.updatePassword({
        currentPassword: 'not-the-password',
        newPassword: NEW_PASSWORD,
        confirmNewPassword: NEW_PASSWORD
      })
    ).rejects.toThrow('Current password is incorrect');

    expect((await localAuthBackend.getUser(laptop.access_token)).data.user?.id).toBe(authId);
  });
});
