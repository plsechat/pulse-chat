import http from 'http';
import z from 'zod';
import { authBackend } from '../utils/auth';
import { getJsonBody } from './helpers';

const zBody = z.object({
  refreshToken: z.string().max(4096).optional()
});

const BEARER_PREFIX = /^Bearer\s+/i;
const MAX_BEARER_LENGTH = 4096;

/**
 * POST /auth/logout — revoke the session family behind the caller's
 * tokens. Local-backend only (404 otherwise, like /auth/refresh): the
 * supabase backend keeps no sessions here and OIDC sessions carry no
 * family.
 *
 * Takes the refresh token in the body and/or the access token as a
 * bearer header — either one names the family, and the refresh token
 * still works once the 15-minute access token has expired. Always
 * answers 200: a logout that reported whether the token was valid
 * would be an oracle for probing stolen tokens.
 */
const logoutRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const json = (status: number, body: object) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return res;
  };

  if (!authBackend.revokeSession) {
    return json(404, { error: 'Logout is not supported by this auth backend' });
  }

  const data = zBody.parse(await getJsonBody(req));

  const authorization = req.headers.authorization;
  const accessToken =
    typeof authorization === 'string' &&
    BEARER_PREFIX.test(authorization) &&
    authorization.length <= MAX_BEARER_LENGTH
      ? authorization.replace(BEARER_PREFIX, '').trim()
      : undefined;

  await authBackend.revokeSession({
    refreshToken: data.refreshToken || undefined,
    accessToken: accessToken || undefined
  });

  return json(200, { success: true });
};

export { logoutRouteHandler };
