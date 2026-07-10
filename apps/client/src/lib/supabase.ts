import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | undefined;

const initSupabase = (url: string, anonKey: string) => {
  if (supabase) return;

  supabase = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true
    }
  });
};

// Try to init from build-time env vars (fallback for dev)
const buildTimeUrl = import.meta.env.VITE_SUPABASE_URL as string;
const buildTimeKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (buildTimeUrl && buildTimeKey) {
  initSupabase(buildTimeUrl, buildTimeKey);
}

// localStorage-held session. Used for AUTH_BACKEND=local installs AND for
// native-OIDC sessions (which are PULSE-minted tokens, NOT Supabase JWTs,
// so they must never go through the supabase client). A token stored here
// always takes precedence over the supabase client session — see
// getAccessToken — so OIDC works even when the supabase client is
// initialized for social login.
const LOCAL_TOKEN_KEY = 'pulse:auth:access_token';
const LOCAL_REFRESH_KEY = 'pulse:auth:refresh_token';

const storeLocalSession = (accessToken: string, refreshToken: string): void => {
  try {
    localStorage.setItem(LOCAL_TOKEN_KEY, accessToken);
    localStorage.setItem(LOCAL_REFRESH_KEY, refreshToken);
  } catch {
    // localStorage can throw in private browsing / quota-exceeded.
    // Worst case: user has to log in again on next page load.
  }
};

const clearLocalSession = (): void => {
  try {
    localStorage.removeItem(LOCAL_TOKEN_KEY);
    localStorage.removeItem(LOCAL_REFRESH_KEY);
  } catch {
    // ignore
  }
};

const setSession = async (
  accessToken: string,
  refreshToken: string
): Promise<void> => {
  if (supabase) {
    await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken
    });
    return;
  }
  storeLocalSession(accessToken, refreshToken);
};

/**
 * Persist a native-OIDC session. Always uses localStorage regardless of
 * whether the supabase client exists — the token is a PULSE token and
 * supabase-js would reject/mangle it. `getAccessToken` reads it first.
 */
const setOidcSession = async (accessToken: string): Promise<void> => {
  storeLocalSession(accessToken, accessToken);
};

const clearSession = async (): Promise<void> => {
  clearLocalSession();
  if (supabase) {
    await supabase.auth.signOut({ scope: 'local' });
  }
};

/**
 * Silently refresh a localStorage-held session (AUTH_BACKEND=local).
 *
 * No-ops (returns null) when there's nothing refreshable:
 *  - no locally-held session (supabase mode → supabase-js auto-refreshes)
 *  - an OIDC session (access and refresh slots hold the SAME token —
 *    see setOidcSession — and OIDC has no refresh; users re-auth via
 *    their IdP when the session token expires)
 *
 * Only a definitive server rejection (401) clears the stored session;
 * network errors leave it intact so a flaky connection can't log the
 * user out.
 */
const refreshLocalSession = async (
  serverUrl: string
): Promise<string | null> => {
  let accessToken: string | null = null;
  let refreshToken: string | null = null;
  try {
    accessToken = localStorage.getItem(LOCAL_TOKEN_KEY);
    refreshToken = localStorage.getItem(LOCAL_REFRESH_KEY);
  } catch {
    return null;
  }

  if (!refreshToken || refreshToken === accessToken) return null;

  try {
    const res = await fetch(`${serverUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });

    if (res.status === 401) {
      clearLocalSession();
      return null;
    }
    if (!res.ok) return null;

    const data = (await res.json()) as {
      accessToken?: string;
      refreshToken?: string;
    };
    if (!data.accessToken || !data.refreshToken) return null;

    storeLocalSession(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    // Network failure — keep the current session and try again later.
    return null;
  }
};

const getAccessToken = async (): Promise<string | null> => {
  // A locally-held token (local backend, or an OIDC session) wins over the
  // supabase client so OIDC works in supabase-backend deployments too.
  try {
    const local = localStorage.getItem(LOCAL_TOKEN_KEY);
    if (local) return local;
  } catch {
    // fall through to supabase
  }
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }
  return null;
};

export {
  clearSession,
  getAccessToken,
  initSupabase,
  refreshLocalSession,
  setOidcSession,
  setSession,
  supabase
};
