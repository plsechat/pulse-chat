/**
 * Expiry of a locally-held access token, read without verifying it: the
 * client only needs to know WHEN to refresh, the server still decides
 * whether the token is good. Pure so it can be unit-tested; no library —
 * base64url + JSON is all a JWT payload is.
 */

/**
 * The token's `exp` as epoch milliseconds, or null when the string is
 * not a JWT with a numeric `exp` (an opaque supabase token, garbage).
 */
const getTokenExpiryMs = (token: string): number | null => {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded)) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
};

/**
 * True when the token expires within `windowMs` of `now` (or already
 * has). A token whose expiry cannot be read is reported as NOT expiring:
 * the caller then sends it as-is and lets the server judge, instead of
 * refreshing on every call.
 */
const isTokenExpiringWithin = (
  token: string,
  windowMs: number,
  now: number = Date.now()
): boolean => {
  const expiresAt = getTokenExpiryMs(token);
  if (expiresAt === null) return false;
  return expiresAt - now <= windowMs;
};

export { getTokenExpiryMs, isTokenExpiringWithin };
