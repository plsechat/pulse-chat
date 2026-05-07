/**
 * AuthBackend — the minimum contract every auth implementation must
 * fulfill. Two backends ship today: `local` (bcrypt + HS256 JWT, no
 * external dep) and `supabase` (the existing managed-Supabase path).
 *
 * Shapes are deliberately a subset of `@supabase/supabase-js`'s admin
 * client — both for backwards-compat with the existing call sites and
 * because the test suite already mocks Supabase in this exact shape
 * (`apps/server/src/__tests__/mock-modules.ts`).
 *
 * The "auth-side id" returned by every method maps to `users.supabaseId`
 * on the app schema — kept named that way so the column doesn't have to
 * be renamed on existing installations. For local-mode users it's a
 * fresh UUID; for supabase-mode users it's whatever Supabase Auth issues.
 *
 * Anything that talks to auth (login.ts, register.ts, provision-user.ts,
 * update-password.ts, getUserByToken, get-auth-providers.ts) goes through
 * this contract — never through `@supabase/supabase-js` directly.
 */

export type AuthSession = {
  access_token: string;
  refresh_token: string;
};

export type AuthIdentity = {
  /** 'email' for password accounts, 'google' / 'github' / etc. for OAuth */
  provider: string;
};

export type AuthUser = {
  id: string;
  email: string | null;
  identities?: AuthIdentity[];
  /**
   * Provider-supplied user metadata. Today only the Supabase backend
   * fills this — the OAuth callback path (provision-user.ts) reads
   * `full_name` / `name` / `preferred_username` to seed a sensible
   * display name. Local mode users go through the password-register
   * flow which already collects a display name explicitly, so this
   * stays undefined.
   */
  metadata?: Record<string, unknown>;
};

export type AuthError = {
  /** Human-readable message — mirrors Supabase's `.error.message` */
  message: string;
  /** Optional canonical reason. `'invalid_credentials'` is the only one
   * the app currently branches on. */
  reason?:
    | 'invalid_credentials'
    | 'user_already_exists'
    | 'user_not_found'
    | 'oauth_only'
    | 'unknown';
};

export type SignInResult =
  | { data: { user: AuthUser; session: AuthSession }; error: null }
  | { data: { user: null; session: null }; error: AuthError };

export type CreateUserResult =
  | { data: { user: AuthUser }; error: null }
  | { data: { user: null }; error: AuthError };

export type GetUserResult =
  | { data: { user: AuthUser }; error: null }
  | { data: { user: null }; error: AuthError | null };

export type UpdateUserResult =
  | { data: { user: AuthUser }; error: null }
  | { data: { user: null }; error: AuthError };

export type AuthBackend = {
  /** Backend identifier. Surfaced for diagnostics + the `pulse:auth`
   * runtime metric. */
  readonly kind: 'local' | 'supabase';

  /** Verify email + password, mint a session token-pair. */
  signInWithPassword(opts: {
    email: string;
    password: string;
  }): Promise<SignInResult>;

  /** Verify a session token. Used on every WS handshake + every HTTP
   * `/upload` / federation handler that needs a user identity. */
  getUser(token: string): Promise<GetUserResult>;

  /** Admin: create a user. Used by /register. */
  createUser(opts: {
    email: string;
    password: string;
  }): Promise<CreateUserResult>;

  /** Admin: lookup a user by auth-side id. Used by get-auth-providers
   * and update-password to discover linked providers + the email
   * needed to call signInWithPassword. */
  getUserById(id: string): Promise<GetUserResult>;

  /** Admin: change a user's password. Used by update-password after
   * the current-password challenge succeeds. */
  updateUserById(
    id: string,
    updates: { password?: string }
  ): Promise<UpdateUserResult>;
};
