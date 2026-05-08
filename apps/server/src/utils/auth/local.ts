/**
 * Local auth backend — bcrypt password verification + HS256 JWT
 * sessions, all in-process. No external service required.
 *
 * Storage
 * =======
 * One table, `local_auth_users`, mirrors what `supabaseAdmin.auth`
 * exposes: a stable per-user id, an email (unique), a bcrypt hash,
 * and a list of linked providers (always `[{provider:'email'}]` in
 * local mode — OAuth is a Supabase-only feature for now). The id
 * stored here is what gets placed on `users.supabaseId` when the
 * registerUser flow runs after createUser.
 *
 * Tokens
 * ======
 * Access + refresh tokens are both HS256 JWTs signed with the
 * server's `AUTH_SECRET`. Access expires in 7 days, refresh in 30.
 * The token verification path (getUser) checks signature + expiry
 * and looks up the user by the embedded `sub` claim. The client
 * holds both tokens but the existing PULSE client only sends the
 * access_token; refresh is reserved for a future endpoint and is
 * emitted today purely to keep the response shape identical to
 * Supabase's so login/register response handling doesn't fork.
 *
 * AUTH_SECRET must be set when `AUTH_BACKEND=local`. The dispatcher
 * (utils/supabase.ts) refuses to load this backend without it.
 */

import { randomUUIDv7 } from 'bun';
import { eq, sql } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import { db } from '../../db';
import { localAuthUsers } from '../../db/schema';
import type {
  AuthBackend,
  AuthError,
  AuthIdentity,
  CreateUserResult,
  GetUserResult,
  SignInResult,
  UpdateUserResult
} from './types';

const ACCESS_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const ISSUER = 'pulse:local-auth';

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

async function signToken(sub: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(getSecret());
}

async function verifyToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: ISSUER
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
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
    const [row] = await db
      .select()
      .from(localAuthUsers)
      .where(eq(localAuthUsers.email, email))
      .limit(1);

    if (!row) {
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

    const accessToken = await signToken(row.id, ACCESS_TOKEN_TTL_SECONDS);
    const refreshToken = await signToken(row.id, REFRESH_TOKEN_TTL_SECONDS);

    return {
      data: {
        user: rowToUser(row),
        session: { access_token: accessToken, refresh_token: refreshToken }
      },
      error: null
    };
  },

  async getUser(token): Promise<GetUserResult> {
    const sub = await verifyToken(token);
    if (!sub) {
      return { data: { user: null }, error: null };
    }
    const [row] = await db
      .select()
      .from(localAuthUsers)
      .where(eq(localAuthUsers.id, sub))
      .limit(1);
    if (!row) {
      return { data: { user: null }, error: null };
    }
    return { data: { user: rowToUser(row) }, error: null };
  },

  async createUser({ email, password }): Promise<CreateUserResult> {
    // Pre-check for an existing email so we can return the canonical
    // error reason. The unique index below catches the race; this just
    // skips the work in the common case.
    const [existing] = await db
      .select({ id: localAuthUsers.id })
      .from(localAuthUsers)
      .where(eq(localAuthUsers.email, email))
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
  }
};

export { localAuthBackend };
