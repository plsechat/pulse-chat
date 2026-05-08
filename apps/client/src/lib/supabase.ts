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

// localStorage fallback for AUTH_BACKEND=local installs. The server
// returns the same `{access_token, refresh_token}` shape regardless of
// backend, so storing them directly works for non-Supabase deployments
// where the JS supabase client isn't initialized.
const LOCAL_TOKEN_KEY = 'pulse:auth:access_token';
const LOCAL_REFRESH_KEY = 'pulse:auth:refresh_token';

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
  // Local mode: persist directly to localStorage. The matching read
  // path in `getAccessToken` checks here when Supabase is unset.
  try {
    localStorage.setItem(LOCAL_TOKEN_KEY, accessToken);
    localStorage.setItem(LOCAL_REFRESH_KEY, refreshToken);
  } catch {
    // localStorage can throw in private browsing / quota-exceeded.
    // Worst case: user has to log in again on next page load.
  }
};

const clearSession = async (): Promise<void> => {
  if (supabase) {
    await supabase.auth.signOut({ scope: 'local' });
    return;
  }
  try {
    localStorage.removeItem(LOCAL_TOKEN_KEY);
    localStorage.removeItem(LOCAL_REFRESH_KEY);
  } catch {
    // ignore
  }
};

const getAccessToken = async (): Promise<string | null> => {
  if (supabase) {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
  }
  try {
    return localStorage.getItem(LOCAL_TOKEN_KEY);
  } catch {
    return null;
  }
};

export {
  clearSession,
  getAccessToken,
  initSupabase,
  setSession,
  supabase
};
