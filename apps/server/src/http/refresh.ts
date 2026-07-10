import http from 'http';
import z from 'zod';
import { getUserBySupabaseId } from '../db/queries/users';
import { logger } from '../logger';
import { authBackend } from '../utils/auth';
import { getJsonBody } from './helpers';

const zBody = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required').max(4096)
});

/**
 * POST /auth/refresh — exchange a refresh token for a fresh, rotated
 * token pair. Local-backend only: supabase-mode clients refresh through
 * supabase-js (`autoRefreshToken: true`) and never call this; OIDC
 * sessions have no refresh token (users re-authenticate via their IdP
 * when the 7-day session token expires).
 *
 * Failures are a plain 401/403 (not HttpValidationError) — the caller
 * is the silent-refresh path in the client, not a form.
 */
const refreshRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const json = (status: number, body: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return res;
  };

  if (!authBackend.refreshSession) {
    // Supabase mode — nothing to refresh server-side.
    return json(404, { error: 'Refresh is not supported by this auth backend' });
  }

  const data = zBody.parse(await getJsonBody(req));

  const { data: refreshed, error } = await authBackend.refreshSession(
    data.refreshToken
  );

  if (error || !refreshed.session || !refreshed.user) {
    logger.debug('[refresh] rejected: %s', error?.message ?? 'no session');
    return json(401, { error: 'Invalid or expired refresh token' });
  }

  // The auth-side user must still map to a live app user. Mirrors the
  // /auth/provision stale-token behavior: a 401 tells the client to
  // drop the stored session.
  const appUser = await getUserBySupabaseId(refreshed.user.id);
  if (!appUser) {
    logger.debug('[refresh] no app user for auth id %s', refreshed.user.id);
    return json(401, { error: 'Invalid or expired refresh token' });
  }

  if (appUser.banned) {
    return json(403, {
      error: `Account banned: ${appUser.banReason || 'No reason provided'}`
    });
  }

  return json(200, {
    success: true,
    accessToken: refreshed.session.access_token,
    refreshToken: refreshed.session.refresh_token
  });
};

export { refreshRouteHandler };
