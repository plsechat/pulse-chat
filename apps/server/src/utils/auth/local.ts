/**
 * Local auth backend — bcrypt password verification + HS256 JWT
 * sessions, all in-process. No external service required.
 *
 * Storage
 * =======
 * One table, `local_auth_users`, mirrors what `supabaseAdmin.auth`
 * exposes: a stable per-user id, an email (unique), a password hash
 * (`Bun.password`, argon2id), and a list of linked providers (always
 * `[{provider:'email'}]` in local mode — OAuth is a Supabase-only
 * feature for now). The id stored here is what gets placed on
 * `users.supabaseId` when the registerUser flow runs after createUser.
 *
 * E-mails are case-insensitive: createUser stores `trim().toLowerCase()`
 * and signInWithPassword matches on `lower(email)` (migration 0030
 * lower-cased existing rows; a row it had to skip because of a collision
 * is still reachable — exact-case match wins, then the oldest row).
 *
 * Unknown-email sign-ins still run one password verification against a
 * static hash so the response time does not reveal whether the address
 * is registered.
 *
 * Tokens
 * ======
 * Access + refresh tokens are both HS256 JWTs signed with the
 * server's `AUTH_SECRET`. Access expires in 15 minutes, refresh in 30
 * days. The two are distinguished by a `typ` claim ('access' |
 * 'refresh'): getUser rejects refresh-typed tokens (a refresh token
 * must never work as a session credential), and refreshSession only
 * accepts refresh-typed ones. A token without a `typ` claim is
 * rejected by both paths.
 *
 * Sessions
 * ========
 * Every refresh token has a row in `local_auth_sessions` keyed by its
 * `jti`; the row's `familyId` (the `sid` claim on BOTH tokens of a
 * pair) groups a sign-in with every rotation that descended from it.
 * refreshSession rotates the pair inside one transaction: the used row
 * is marked revoked + `replacedBy` the child, the child is inserted,
 * and a new pair is minted — active users get a sliding 30-day window
 * while idle sessions still expire. Presenting an already-rotated
 * refresh token again is either the two-tabs race (rotated less than
 * REFRESH_REUSE_GRACE_MS ago and the family still alive → rotate again
 * without punishing anyone) or a replayed stolen token → the whole
 * family is revoked and the caller rejected.
 *
 * Logout (revokeSession) and a password change (revokeAllSessions)
 * revoke families outright. getUser rejects an access token whose
 * family has no live row; the answer is cached in-process for
 * REVOCATION_CACHE_TTL_MS, and a revocation performed here flips the
 * cache entry immediately — PULSE runs one process per database
 * (README "Deployment model"), so in-process is authoritative and the
 * DB read on a cache miss covers restarts. Revoking a family also
 * closes its live WebSocket connections (utils/session-registry.ts).
 *
 * AUTH_SECRET must be set when `AUTH_BACKEND=local`. The dispatcher
 * (utils/auth/index.ts) refuses to load this backend without it.
 */

import { randomUUIDv7 } from 'bun';
import { and, asc, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { db } from '../../db';
import { localAuthSessions, localAuthUsers, users } from '../../db/schema';
import { closeSocketsForFamily } from '../session-registry';
import type {
  AuthBackend,
  AuthError,
  AuthIdentity,
  CreateUserResult,
  GetUserResult,
  SignInResult,
  UpdateUserResult
} from './types';

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const ISSUER = 'pulse:local-auth';

/**
 * A refresh token presented again within this long after it was rotated
 * is the two-tabs race (both tabs read the same refresh token from
 * localStorage and refreshed at once), not a replay: the second caller
 * gets its own pair from the same family. Past the window a reuse is
 * treated as theft and the family dies.
 */
const REFRESH_REUSE_GRACE_MS = 30_000;

/**
 * How long getUser trusts a "family still alive" answer before it reads
 * the sessions table again. Revocations performed in this process bypass
 * the window (the entry is flipped at once); the TTL only bounds how
 * stale an answer from BEFORE a restart can be.
 */
const REVOCATION_CACHE_TTL_MS = 30_000;

/** Hard cap on cached families: oldest entry out when exceeded. */
const REVOCATION_CACHE_MAX_ENTRIES = 10_000;

/**
 * Sockets of a family revoked by revokeAllSessions are closed this long
 * after the revocation: the mutation that triggered it (a password
 * change) answers over one of the caller's own sockets, and that socket
 * is only spared when the caller's family could be identified. Same
 * reason as the deferred close in utils/account-deletion.ts.
 */
const REVOKE_ALL_SOCKET_CLOSE_DELAY_MS = 1500;

/**
 * Verified against when the e-mail is unknown so the unknown-email and
 * wrong-password paths cost the same. Same algorithm + parameters as
 * `Bun.password.hash` defaults (argon2id, m=65536, t=2, p=1); the
 * plaintext behind it is irrelevant — nothing is ever expected to match.
 */
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,t=2,p=1$SYa0By3J9AMtEydW+DU4+yccOhDSKuQ8GBlxbxF1QH8$a9j64WKHpxO5ihJVNbtUJX0POumC66UrRhqraVNOzLc';

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function err(message: string, reason: AuthError['reason'] = 'unknown'): AuthError {
  return { message, reason };
}

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      'AUTH_BACKEND=local requires AUTH_SECRET to be set to at least 32 characters'
    );
  }
  return new TextEncoder().encode(raw);
}

type TokenType = 'access' | 'refresh';

type TokenClaims = {
  /** Auth-side user id (`local_auth_users.id`). */
  sub: string;
  /** Session family id; the refresh row's `familyId`. */
  sid: string;
  /** Unique per token; for refresh tokens it is the session row id. */
  jti: string;
};

/** The query surface shared by `db` and a transaction handle. */
type Executor = Pick<typeof db, 'select' | 'insert' | 'update'>;

async function signToken(opts: {
  sub: string;
  typ: TokenType;
  sid: string;
  jti: string;
  ttlSeconds: number;
}): Promise<string> {
  return new SignJWT({ typ: opts.typ, sid: opts.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setJti(opts.jti)
    .setExpirationTime(Math.floor(Date.now() / 1000) + opts.ttlSeconds)
    .sign(getSecret());
}

/**
 * Verify a token and return its claims, or null.
 *
 * `expect` gates on the `typ` claim: the token must carry exactly the
 * expected type. Tokens without `typ`, `sid` or `jti` are rejected —
 * a pair minted before sessions existed has no family to check against.
 *
 * `forRevocation` tolerates an expired token: a signed token still
 * proves which family it belongs to, and revoking a family can never
 * grant anything. Bounded by the refresh TTL — older than that and no
 * row of the family can be live anyway.
 */
async function verifyToken(
  token: string,
  expect: TokenType,
  opts: { forRevocation?: boolean } = {}
): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER,
      clockTolerance: opts.forRevocation ? REFRESH_TOKEN_TTL_SECONDS : 0
    });
    if (payload.typ !== expect) return null;
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.jti !== 'string'
    ) {
      return null;
    }
    return { sub: payload.sub, sid: payload.sid, jti: payload.jti };
  } catch {
    return null;
  }
}

/**
 * Mint an access + refresh pair and record the refresh token's session
 * row. A sign-in starts a new family; a rotation passes the family it
 * continues. Runs on the caller's executor so refreshSession can insert
 * the child inside the transaction that retires the parent.
 */
async function mintSession(
  executor: Executor,
  sub: string,
  familyId: string = randomUUIDv7()
) {
  const now = Date.now();
  const refreshJti = randomUUIDv7();

  const [accessToken, refreshToken] = await Promise.all([
    signToken({
      sub,
      typ: 'access',
      sid: familyId,
      jti: randomUUIDv7(),
      ttlSeconds: ACCESS_TOKEN_TTL_SECONDS
    }),
    signToken({
      sub,
      typ: 'refresh',
      sid: familyId,
      jti: refreshJti,
      ttlSeconds: REFRESH_TOKEN_TTL_SECONDS
    })
  ]);

  await executor.insert(localAuthSessions).values({
    id: refreshJti,
    userId: sub,
    familyId,
    createdAt: now,
    expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000
  });

  return {
    session: { access_token: accessToken, refresh_token: refreshToken },
    familyId,
    refreshJti
  };
}

/** True while the family still has an unrevoked, unexpired refresh row. */
async function hasLiveSession(
  executor: Executor,
  familyId: string
): Promise<boolean> {
  const [row] = await executor
    .select({ id: localAuthSessions.id })
    .from(localAuthSessions)
    .where(
      and(
        eq(localAuthSessions.familyId, familyId),
        isNull(localAuthSessions.revokedAt),
        gt(localAuthSessions.expiresAt, Date.now())
      )
    )
    .limit(1);
  return row !== undefined;
}

// ---- revocation cache -------------------------------------------------

const familyStatusCache = new Map<
  string,
  { revoked: boolean; checkedAt: number }
>();

/** Insertion order doubles as eviction order: re-insert to refresh. */
const rememberFamilyStatus = (familyId: string, revoked: boolean) => {
  familyStatusCache.delete(familyId);
  familyStatusCache.set(familyId, { revoked, checkedAt: Date.now() });
  if (familyStatusCache.size > REVOCATION_CACHE_MAX_ENTRIES) {
    const oldest = familyStatusCache.keys().next().value;
    if (oldest !== undefined) familyStatusCache.delete(oldest);
  }
};

const markFamilyRevoked = (familyId: string) =>
  rememberFamilyStatus(familyId, true);

/** Test hook: forget every cached answer so the next check hits the DB. */
const resetSessionRevocationCache = () => familyStatusCache.clear();

/**
 * Whether an access token of `familyId` must be rejected. A revoked
 * answer is final (families never come back); an alive answer is trusted
 * for REVOCATION_CACHE_TTL_MS, then re-read.
 */
async function isFamilyRevoked(familyId: string): Promise<boolean> {
  const cached = familyStatusCache.get(familyId);
  if (cached) {
    if (cached.revoked) return true;
    if (Date.now() - cached.checkedAt < REVOCATION_CACHE_TTL_MS) return false;
  }

  const alive = await hasLiveSession(db, familyId);
  rememberFamilyStatus(familyId, !alive);
  return !alive;
}

// ---- revocation -------------------------------------------------------

/**
 * Close the live sockets of `familyId`. The registry is keyed by app
 * user id, the backend only knows the auth-side id; the mapping is a
 * direct read of `users` (db/queries/users.ts imports the auth
 * dispatcher, so going through it would be a cycle). The lookup is
 * awaited by the caller — only the in-memory close is ever deferred —
 * so no query outlives the request that started it.
 */
async function closeFamilySockets(
  authUserId: string,
  familyIds: string[],
  deferMs = 0
): Promise<void> {
  if (familyIds.length === 0) return;

  const [appUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.supabaseId, authUserId))
    .limit(1);
  if (!appUser) return;

  const run = () => {
    for (const familyId of familyIds) {
      closeSocketsForFamily(appUser.id, familyId);
    }
  };

  if (deferMs > 0) setTimeout(run, deferMs);
  else run();
}

/** Revoke one family: every live row, the cache entry, the sockets. */
async function revokeFamily(
  authUserId: string,
  familyId: string,
  deferSocketCloseMs = 0
): Promise<void> {
  await db
    .update(localAuthSessions)
    .set({ revokedAt: Date.now() })
    .where(
      and(
        eq(localAuthSessions.userId, authUserId),
        eq(localAuthSessions.familyId, familyId),
        isNull(localAuthSessions.revokedAt)
      )
    );
  markFamilyRevoked(familyId);
  await closeFamilySockets(authUserId, [familyId], deferSocketCloseMs);
}

function rowToUser(row: typeof localAuthUsers.$inferSelect) {
  let identities: AuthIdentity[];
  try {
    identities =
      typeof row.identities === 'string'
        ? (JSON.parse(row.identities) as AuthIdentity[])
        : (row.identities as AuthIdentity[]);
  } catch {
    identities = [{ provider: 'email' }];
  }
  return {
    id: row.id,
    email: row.email,
    identities
  };
}

const localAuthBackend: AuthBackend = {
  kind: 'local',

  async signInWithPassword({ email, password }): Promise<SignInResult> {
    const normalized = normalizeEmail(email);

    // Exact-case row first, then the oldest — only matters for rows the
    // 0030 migration could not lower-case because of a collision.
    const [row] = await db
      .select()
      .from(localAuthUsers)
      .where(sql`lower(${localAuthUsers.email}) = ${normalized}`)
      .orderBy(
        desc(sql`${localAuthUsers.email} = ${normalized}`),
        asc(localAuthUsers.id)
      )
      .limit(1);

    if (!row) {
      // Burn the same work a real verification costs — see
      // DUMMY_PASSWORD_HASH.
      await Bun.password.verify(password, DUMMY_PASSWORD_HASH);
      return {
        data: { user: null, session: null },
        error: err('Invalid login credentials', 'invalid_credentials')
      };
    }

    const ok = await Bun.password.verify(password, row.passwordHash);
    if (!ok) {
      return {
        data: { user: null, session: null },
        error: err('Invalid login credentials', 'invalid_credentials')
      };
    }

    const { session } = await mintSession(db, row.id);
    return {
      data: { user: rowToUser(row), session },
      error: null
    };
  },

  async getUser(token): Promise<GetUserResult> {
    const claims = await verifyToken(token, 'access');
    if (!claims) {
      return { data: { user: null }, error: null };
    }
    if (await isFamilyRevoked(claims.sid)) {
      return { data: { user: null }, error: null };
    }
    const [row] = await db
      .select()
      .from(localAuthUsers)
      .where(eq(localAuthUsers.id, claims.sub))
      .limit(1);
    if (!row) {
      return { data: { user: null }, error: null };
    }
    return { data: { user: rowToUser(row) }, error: null };
  },

  async refreshSession(refreshToken): Promise<SignInResult> {
    const rejected = (): SignInResult => ({
      data: { user: null, session: null },
      error: err('Invalid or expired refresh token', 'invalid_credentials')
    });

    const claims = await verifyToken(refreshToken, 'refresh');
    if (!claims) return rejected();

    const [row] = await db
      .select()
      .from(localAuthUsers)
      .where(eq(localAuthUsers.id, claims.sub))
      .limit(1);
    if (!row) {
      return {
        data: { user: null, session: null },
        error: err('User not found', 'user_not_found')
      };
    }

    // The row lock serialises two refreshes of the same token: the
    // second one sees the first's rotation and takes the race path
    // instead of both minting from an unrevoked row.
    const outcome = await db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(localAuthSessions)
        .where(eq(localAuthSessions.id, claims.jti))
        .for('update');
      const now = Date.now();

      if (
        !session ||
        session.userId !== claims.sub ||
        session.familyId !== claims.sid
      ) {
        return { kind: 'unknown' as const };
      }
      if (session.expiresAt <= now) {
        return { kind: 'expired' as const };
      }

      if (session.revokedAt !== null) {
        const rotatedJustNow =
          session.replacedBy !== null &&
          now - session.revokedAt <= REFRESH_REUSE_GRACE_MS;
        if (rotatedJustNow && (await hasLiveSession(tx, session.familyId))) {
          // Two tabs refreshed at once: the second gets its own pair
          // from the same family, nothing is revoked.
          return {
            kind: 'ok' as const,
            minted: await mintSession(tx, claims.sub, session.familyId)
          };
        }
        // Replay of a retired token (or of a family already revoked by
        // logout): whoever holds the current pair loses it too.
        await tx
          .update(localAuthSessions)
          .set({ revokedAt: now })
          .where(
            and(
              eq(localAuthSessions.familyId, session.familyId),
              isNull(localAuthSessions.revokedAt)
            )
          );
        return { kind: 'reused' as const, familyId: session.familyId };
      }

      const minted = await mintSession(tx, claims.sub, session.familyId);
      await tx
        .update(localAuthSessions)
        .set({ revokedAt: now, replacedBy: minted.refreshJti })
        .where(eq(localAuthSessions.id, session.id));
      return { kind: 'ok' as const, minted };
    });

    if (outcome.kind === 'reused') {
      markFamilyRevoked(outcome.familyId);
      await closeFamilySockets(claims.sub, [outcome.familyId]);
      return rejected();
    }
    if (outcome.kind !== 'ok') return rejected();

    return {
      data: { user: rowToUser(row), session: outcome.minted.session },
      error: null
    };
  },

  async revokeSession({ refreshToken, accessToken }): Promise<void> {
    try {
      const claims =
        (refreshToken
          ? await verifyToken(refreshToken, 'refresh', { forRevocation: true })
          : null) ??
        (accessToken
          ? await verifyToken(accessToken, 'access', { forRevocation: true })
          : null);
      if (!claims) return;
      await revokeFamily(claims.sub, claims.sid);
    } catch {
      // Logout must never fail on what the client sent; a token that
      // cannot be verified has nothing to revoke.
    }
  },

  async revokeAllSessions(userId, opts = {}): Promise<void> {
    const { exceptFamilyId } = opts;
    const liveOfUser = and(
      eq(localAuthSessions.userId, userId),
      isNull(localAuthSessions.revokedAt),
      exceptFamilyId !== undefined
        ? ne(localAuthSessions.familyId, exceptFamilyId)
        : undefined
    );

    const families = await db
      .selectDistinct({ familyId: localAuthSessions.familyId })
      .from(localAuthSessions)
      .where(liveOfUser);
    if (families.length === 0) return;

    await db
      .update(localAuthSessions)
      .set({ revokedAt: Date.now() })
      .where(liveOfUser);

    const familyIds = families.map((f) => f.familyId);
    for (const familyId of familyIds) markFamilyRevoked(familyId);
    await closeFamilySockets(
      userId,
      familyIds,
      REVOKE_ALL_SOCKET_CLOSE_DELAY_MS
    );
  },

  async createUser({ email: rawEmail, password }): Promise<CreateUserResult> {
    const email = normalizeEmail(rawEmail);

    // Pre-check for an existing email so we can return the canonical
    // error reason. The unique index below catches the race; this just
    // skips the work in the common case. Case-insensitive so a mixed-case
    // row the 0030 migration had to skip still blocks its lower-cased
    // twin.
    const [existing] = await db
      .select({ id: localAuthUsers.id })
      .from(localAuthUsers)
      .where(sql`lower(${localAuthUsers.email}) = ${email}`)
      .limit(1);
    if (existing) {
      return {
        data: { user: null },
        error: err(
          'A user with this email has already been registered',
          'user_already_exists'
        )
      };
    }

    const id = randomUUIDv7();
    const passwordHash = await Bun.password.hash(password);
    const identities: AuthIdentity[] = [{ provider: 'email' }];

    try {
      await db.insert(localAuthUsers).values({
        id,
        email,
        passwordHash,
        identities: JSON.stringify(identities),
        createdAt: Date.now()
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // postgres unique_violation = 23505
      if (
        message.includes('duplicate key') ||
        message.includes('23505') ||
        message.toLowerCase().includes('unique')
      ) {
        return {
          data: { user: null },
          error: err(
            'A user with this email has already been registered',
            'user_already_exists'
          )
        };
      }
      return { data: { user: null }, error: err(message) };
    }

    return {
      data: { user: { id, email, identities } },
      error: null
    };
  },

  async getUserById(id): Promise<GetUserResult> {
    const [row] = await db
      .select()
      .from(localAuthUsers)
      .where(eq(localAuthUsers.id, id))
      .limit(1);
    if (!row) {
      return { data: { user: null }, error: err('User not found', 'user_not_found') };
    }
    return { data: { user: rowToUser(row) }, error: null };
  },

  async updateUserById(id, updates): Promise<UpdateUserResult> {
    if (!updates.password) {
      // Nothing to do — return current row.
      const cur = await this.getUserById(id);
      if (cur.data.user) {
        return { data: { user: cur.data.user }, error: null };
      }
      return { data: { user: null }, error: err('User not found', 'user_not_found') };
    }

    const passwordHash = await Bun.password.hash(updates.password);
    const [updated] = await db
      .update(localAuthUsers)
      .set({ passwordHash, updatedAt: sql`${Date.now()}` })
      .where(eq(localAuthUsers.id, id))
      .returning();

    if (!updated) {
      return { data: { user: null }, error: err('User not found', 'user_not_found') };
    }
    return { data: { user: rowToUser(updated) }, error: null };
  },

  async deleteUserById(id): Promise<{ error: AuthError | null }> {
    // Deleting the row severs login instantly: getUser resolves the
    // token's sub against this table on every request, so live HS256
    // tokens die with the row. Idempotent by design.
    await db.delete(localAuthUsers).where(eq(localAuthUsers.id, id));
    return { error: null };
  }
};

export {
  localAuthBackend,
  REFRESH_REUSE_GRACE_MS,
  resetSessionRevocationCache
};
