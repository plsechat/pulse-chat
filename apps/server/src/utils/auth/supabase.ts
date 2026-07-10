/**
 * Supabase auth backend — thin contract-shaped wrapper over the
 * existing `@supabase/supabase-js` admin client. Lifts what used to
 * live in `apps/server/src/utils/supabase.ts` directly into the
 * AuthBackend shape so the call sites in login / register / provision
 * etc. don't have to know which backend they're talking to.
 *
 * Loaded only when `AUTH_BACKEND=supabase` (or unset, when SUPABASE_URL
 * is present). The dispatcher in `utils/supabase.ts` decides.
 */

// `@supabase/supabase-js` is loaded lazily — only when this backend is
// actually selected and a method is called. Eagerly importing it
// crashed `AUTH_BACKEND=local` deployments at boot: somewhere during
// supabase-auth-js's module-evaluation, the bun-compiled binary hit
// `TypeError: undefined is not an object (evaluating 'x.info')` and
// the process exited before the dispatcher ever reached local mode.
// Keeping the import lazy means local-mode containers never run any
// supabase initialization code.
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthBackend,
  AuthError,
  CreateUserResult,
  GetUserResult,
  SignInResult,
  UpdateUserResult
} from './types';

let _client: SupabaseClient | null = null;

async function getClient(): Promise<SupabaseClient> {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'AUTH_BACKEND=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }
  const { createClient } = await import('@supabase/supabase-js');
  _client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return _client;
}

function mapError(message: string): AuthError {
  // Map the small set of Supabase error strings we currently branch on.
  const lower = message.toLowerCase();
  let reason: AuthError['reason'] = 'unknown';
  if (
    lower.includes('already been registered') ||
    lower.includes('already exists') ||
    lower.includes('already registered')
  ) {
    reason = 'user_already_exists';
  } else if (lower.includes('invalid login') || lower.includes('invalid credentials')) {
    reason = 'invalid_credentials';
  } else if (lower.includes('not found')) {
    reason = 'user_not_found';
  }
  return { message, reason };
}

const supabaseAuthBackend: AuthBackend = {
  kind: 'supabase',

  async signInWithPassword({ email, password }): Promise<SignInResult> {
    const { data, error } = await (await getClient()).auth.signInWithPassword({
      email,
      password
    });
    if (error || !data.session || !data.user) {
      return {
        data: { user: null, session: null },
        error: mapError(error?.message ?? 'Sign-in failed')
      };
    }
    return {
      data: {
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          identities: (data.user.identities ?? [])
            .map((i) => ({ provider: i.provider }))
            .filter((i) => typeof i.provider === 'string'),
          metadata: data.user.user_metadata as Record<string, unknown> | undefined
        },
        session: {
          access_token: data.session.access_token,
          refresh_token: data.session.refresh_token
        }
      },
      error: null
    };
  },

  async getUser(token): Promise<GetUserResult> {
    const { data, error } = await (await getClient()).auth.getUser(token);
    if (error || !data.user) {
      return { data: { user: null }, error: error ? mapError(error.message) : null };
    }
    return {
      data: {
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          identities: (data.user.identities ?? [])
            .map((i) => ({ provider: i.provider }))
            .filter((i) => typeof i.provider === 'string'),
          metadata: data.user.user_metadata as Record<string, unknown> | undefined
        }
      },
      error: null
    };
  },

  async createUser({ email, password }): Promise<CreateUserResult> {
    const { data, error } = await (await getClient()).auth.admin.createUser({
      email,
      password,
      email_confirm: true
    });
    if (error || !data.user) {
      return {
        data: { user: null },
        error: mapError(error?.message ?? 'Failed to create user')
      };
    }
    return {
      data: {
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          identities: (data.user.identities ?? [])
            .map((i) => ({ provider: i.provider }))
            .filter((i) => typeof i.provider === 'string'),
          metadata: data.user.user_metadata as Record<string, unknown> | undefined
        }
      },
      error: null
    };
  },

  async getUserById(id): Promise<GetUserResult> {
    const { data, error } = await (await getClient()).auth.admin.getUserById(id);
    if (error || !data.user) {
      return {
        data: { user: null },
        error: error ? mapError(error.message) : { message: 'User not found', reason: 'user_not_found' }
      };
    }
    return {
      data: {
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          identities: (data.user.identities ?? [])
            .map((i) => ({ provider: i.provider }))
            .filter((i) => typeof i.provider === 'string'),
          metadata: data.user.user_metadata as Record<string, unknown> | undefined
        }
      },
      error: null
    };
  },

  async updateUserById(id, updates): Promise<UpdateUserResult> {
    const { data, error } = await (await getClient()).auth.admin.updateUserById(
      id,
      updates
    );
    if (error || !data.user) {
      return {
        data: { user: null },
        error: mapError(error?.message ?? 'Failed to update user')
      };
    }
    return {
      data: {
        user: {
          id: data.user.id,
          email: data.user.email ?? null,
          identities: (data.user.identities ?? [])
            .map((i) => ({ provider: i.provider }))
            .filter((i) => typeof i.provider === 'string'),
          metadata: data.user.user_metadata as Record<string, unknown> | undefined
        }
      },
      error: null
    };
  }
};

export { supabaseAuthBackend };
