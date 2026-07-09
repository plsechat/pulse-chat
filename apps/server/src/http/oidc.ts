/**
 * OIDC HTTP endpoints.
 *
 *   GET /auth/oidc/start    — begin the flow: discover, build the PKCE
 *                             authorize URL, drop a signed state cookie,
 *                             302 to the IdP.
 *   GET /auth/oidc/callback — the IdP redirects here with ?code&state;
 *                             exchange the code, verify the id_token,
 *                             provision the app user, mint a PULSE session
 *                             and hand it to the SPA in the URL fragment.
 *
 * The session PULSE mints is self-contained (see utils/oidc.ts), so this
 * works under both AUTH_BACKEND=local and =supabase with no GoTrue.
 */

import { eq, sql } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { isInviteValid } from '../db/queries/invites';
import { getSettings } from '../db/queries/server';
import { getUserBySupabaseId, isDisplayNameTaken } from '../db/queries/users';
import { invites, users } from '../db/schema';
import { getWsInfo } from '../helpers/get-ws-info';
import { logger } from '../logger';
import { registerUser } from './register-user';
import { isRegistrationDisabled } from '../utils/env';
import {
  buildAuthorizeUrl,
  exchangeCode,
  getDiscovery,
  getOidcConfig,
  mintSessionToken,
  oidcSupabaseId,
  OIDC_STATE_COOKIE,
  pkceChallenge,
  randomToken,
  signState,
  verifyIdToken,
  verifyState,
  type OidcClaims
} from '../utils/oidc';

// --- request helpers -------------------------------------------------------

function getRequestOrigin(req: http.IncomingMessage): {
  origin: string;
  isHttps: boolean;
} {
  const proto = (
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ||
    'https'
  ).trim();
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ||
    req.headers.host ||
    'localhost';
  return { origin: `${proto}://${host}`, isHttps: proto === 'https' };
}

/**
 * Read a single named cookie. Deliberately matches only the requested name
 * rather than building a map keyed by user-controlled cookie names (which
 * is a property-injection / prototype-pollution vector).
 */
function getCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}


function redirect(res: http.ServerResponse, location: string, setCookie?: string) {
  const headers: http.OutgoingHttpHeaders = { Location: location };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(302, headers);
  res.end();
}

function stateCookie(value: string, isHttps: boolean, maxAge: number): string {
  const attrs = [
    `${OIDC_STATE_COOKIE}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/auth/oidc',
    `Max-Age=${maxAge}`
  ];
  if (isHttps) attrs.push('Secure');
  return attrs.join('; ');
}

// --- provisioning ----------------------------------------------------------

/**
 * Resolve the app user for a set of verified OIDC claims, creating one on
 * first login. Mirrors the OAuth path in provision-user.ts: honours the
 * registration/invite policy, seeds a display name from the IdP, and
 * rejects banned accounts. Returns the `users.supabaseId` to encode in the
 * session token.
 */
async function findOrProvisionOidcUser(
  claims: OidcClaims,
  invite: string | undefined,
  ip: string | undefined
): Promise<string> {
  const supabaseId = oidcSupabaseId(claims.sub);
  // Display name: the IdP's name claim, falling back to the email local
  // part and finally a subject-derived placeholder.
  const preferredName =
    claims.name ||
    (claims.email && claims.email.split('@')[0]) ||
    `user-${claims.sub.slice(0, 8)}`;
  const existing = await getUserBySupabaseId(supabaseId);

  if (existing) {
    if (existing.banned) {
      throw new Error(`Account banned: ${existing.banReason || 'No reason provided'}`);
    }
    // Backfill a real display name if the account still has the generic one.
    if (existing.name === 'New User') {
      const taken = await isDisplayNameTaken(preferredName, existing.id);
      if (!taken) {
        await db
          .update(users)
          .set({ name: preferredName, updatedAt: Date.now() })
          .where(eq(users.id, existing.id));
      }
    }
    return supabaseId;
  }

  // New user — enforce the same registration policy the OAuth path does.
  const settings = await getSettings();
  if (isRegistrationDisabled() || !settings.allowNewUsers) {
    const inviteError = await isInviteValid(invite);
    if (inviteError) {
      throw new Error(inviteError);
    }
    await db
      .update(invites)
      .set({ uses: sql`${invites.uses} + 1` })
      .where(eq(invites.code, invite!))
      .execute();
  }

  let name = preferredName;
  if (await isDisplayNameTaken(name)) {
    name = `${name}-${randomToken(3).slice(0, 4)}`;
  }

  await registerUser(supabaseId, invite, ip, name);
  logger.info(`Provisioned new OIDC user for subject ${claims.sub.replace(/[\r\n]/g, '')}`);
  return supabaseId;
}

// --- handlers --------------------------------------------------------------

export async function oidcStartRouteHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const config = getOidcConfig();
  if (!config) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OIDC is not configured on this server' }));
    return;
  }

  const { origin, isHttps } = getRequestOrigin(req);
  const url = new URL(req.url || '/', origin);
  const invite = url.searchParams.get('invite') || undefined;
  const redirectUri = config.redirectUriOverride || `${origin}/auth/oidc/callback`;

  try {
    const discovery = await getDiscovery(config.issuer);

    const state = randomToken();
    const verifier = randomToken();
    const nonce = randomToken();
    const challenge = await pkceChallenge(verifier);

    const cookieValue = await signState({ state, verifier, nonce, redirectUri, invite });
    const authorizeUrl = buildAuthorizeUrl(config, discovery, {
      redirectUri,
      state,
      challenge,
      nonce
    });

    redirect(res, authorizeUrl, stateCookie(cookieValue, isHttps, 600));
  } catch (err) {
    logger.error('OIDC start failed: %o', err);
    redirect(res, `${origin}/?oidc_error=${encodeURIComponent('Login could not be started')}`);
  }
}

export async function oidcCallbackRouteHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse
) {
  const config = getOidcConfig();
  const { origin, isHttps } = getRequestOrigin(req);
  const clearCookie = stateCookie('', isHttps, 0);

  const fail = (msg: string) =>
    redirect(res, `${origin}/?oidc_error=${encodeURIComponent(msg)}`, clearCookie);

  if (!config) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'OIDC is not configured on this server' }));
    return;
  }

  const url = new URL(req.url || '/', origin);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');
  const idpError = url.searchParams.get('error');

  if (idpError) {
    logger.warn('OIDC provider returned error: %s', idpError.replace(/[\r\n]/g, ''));
    return fail('Login was cancelled or denied');
  }
  if (!code || !returnedState) {
    return fail('Missing authorization code');
  }

  const stateToken = getCookie(req, OIDC_STATE_COOKIE);
  const state = stateToken ? await verifyState(stateToken) : null;

  if (!state || state.state !== returnedState) {
    return fail('Login session expired or invalid — please try again');
  }

  try {
    const discovery = await getDiscovery(config.issuer);
    const tokens = await exchangeCode(config, discovery, {
      code,
      redirectUri: state.redirectUri,
      verifier: state.verifier
    });
    if (!tokens.id_token) {
      return fail('Identity provider did not return an id_token');
    }

    const claims = await verifyIdToken(config, discovery, tokens.id_token, state.nonce);
    const ip = getWsInfo(undefined, req)?.ip;
    const supabaseId = await findOrProvisionOidcUser(claims, state.invite, ip);
    const accessToken = await mintSessionToken(supabaseId);

    // Hand the token to the SPA in the URL fragment (never sent to a
    // server) and let its boot code pick it up. Carry the invite through
    // so the client's existing server-join flow still runs.
    const fragment = new URLSearchParams({ pulse_oidc_token: accessToken });
    const query = state.invite ? `?invite=${encodeURIComponent(state.invite)}` : '';
    redirect(res, `${origin}/${query}#${fragment.toString()}`, clearCookie);
  } catch (err) {
    logger.error('OIDC callback failed: %o', err);
    const msg = err instanceof Error && err.message.startsWith('Account banned')
      ? err.message
      : 'Login failed — please try again';
    return fail(msg);
  }
}
