import { getUrlFromServer } from '@/helpers/get-file-url';
import { isTokenExpiringWithin } from '@/lib/token-expiry';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabase: SupabaseClient | undefined;

/**
 * Created from the server's /info config (loadApp) — the one source of
 * truth for which Supabase project, if any, this deployment uses. There
 * is no build-time fallback: a bundle baked with another project's keys
 * would otherwise keep that client and silently ignore the server's, and
 * against an AUTH_BACKEND=local server it would route setSession through
 * supabase-js, which rejects the server-minted tokens.
 */
const initSupabase = (url: string, anonKey: string) => {
  if (supabase) return;

  supabase = createClient(url, anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true
    }
  });
};

// localStorage-held session. Used for AUTH_BACKEND=local installs AND for
// native-OIDC sessions (which are PULSE-minted tokens, NOT Supabase JWTs,
// so they must never go through the supabase client). A token stored here
// always takes precedence over the supabase client session — see
// getAccessToken — so OIDC works even when the supabase client is
// initialized for social login.
const LOCAL_TOKEN_KEY = 'pulse:auth:access_token';
const LOCAL_REFRESH_KEY = 'pulse:auth:refresh_token';

/**
 * A local-backend access token lives 15 minutes; one this close to its
 * end is renewed BEFORE it is handed out, so a request never leaves with
 * a token that expires in flight.
 */
const ACCESS_TOKEN_RENEW_WINDOW_MS = 60_000;

/**
 * The stored pair, or null. `isLocal` tells a refreshable local-backend
 * session (distinct refresh token) from a native-OIDC one, which stores
 * the same token in both slots and has no refresh or logout call.
 */
const readLocalSession = (): {
  accessToken: string;
  refreshToken: string | null;
  isLocal: boolean;
} | null => {
  try {
    const accessToken = localStorage.getItem(LOCAL_TOKEN_KEY);
    if (!accessToken) return null;
    const refreshToken = localStorage.getItem(LOCAL_REFRESH_KEY);
    return {
      accessToken,
      refreshToken,
      isLocal: !!refreshToken && refreshToken !== accessToken
    };
  } catch {
    return null;
  }
};

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

/**
 * Sign out. For a local-backend session the server is told first so the
 * refresh token (and every access token of that session) dies there
 * too — clearing storage alone would leave a copied refresh token valid
 * for 30 days. Fire-and-forget with `keepalive` so a sign-out followed
 * by navigation still lands; a failure is not worth blocking the UI
 * over, the tokens are gone from this browser either way.
 */
const clearSession = async (): Promise<void> => {
  const stored = readLocalSession();
  if (stored?.isLocal && stored.refreshToken) {
    try {
      void fetch(`${getUrlFromServer()}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: stored.refreshToken }),
        keepalive: true
      }).catch(() => undefined);
    } catch {
      // fetch itself can throw synchronously in odd environments.
    }
  }

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
let refreshInFlight: Promise<string | null> | null = null;

const refreshLocalSession = (serverUrl: string): Promise<string | null> => {
  // One refresh at a time: the connection params, the reconnect loop and
  // an upload can all ask for a token in the same tick. Each refresh
  // retires the token it was given, so two concurrent ones would race
  // for the same refresh token and one of them would be a reuse.
  if (!refreshInFlight) {
    refreshInFlight = performLocalRefresh(serverUrl).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
};

const performLocalRefresh = async (
  serverUrl: string
): Promise<string | null> => {
  const stored = readLocalSession();
  if (!stored?.isLocal || !stored.refreshToken) return null;
  const refreshToken = stored.refreshToken;

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

/**
 * The access token to send right now. A locally-held token (local
 * backend, or an OIDC session) wins over the supabase client so OIDC
 * works in supabase-backend deployments too. A local-backend token that
 * is about to expire is renewed first; when that fails on a network
 * error the stale token is returned and the server decides (a 401 from
 * the refresh route has already cleared the session, so null then).
 */
const getAccessToken = async (): Promise<string | null> => {
  const stored = readLocalSession();
  if (stored) {
    if (
      stored.isLocal &&
      isTokenExpiringWithin(stored.accessToken, ACCESS_TOKEN_RENEW_WINDOW_MS)
    ) {
      const renewed = await refreshLocalSession(getUrlFromServer());
      if (renewed) return renewed;
      return readLocalSession()?.accessToken ?? null;
    }
    return stored.accessToken;
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
