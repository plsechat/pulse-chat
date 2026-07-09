/**
 * Native OpenID Connect (OIDC) support.
 *
 * PULSE performs the OIDC authorization-code + PKCE flow itself rather
 * than delegating to Supabase/GoTrue — GoTrue only ships fixed provider
 * implementations (its "keycloak" slot hardcodes Keycloak realm paths and
 * can't front Authentik). Doing OIDC in-process works with any
 * standards-compliant IdP (Authentik, Keycloak, Zitadel, Auth0, …) and in
 * either auth backend, because the session it issues is self-contained.
 *
 * Session model
 * =============
 * After a successful login PULSE mints its OWN session token — an HS256
 * JWT signed with AUTH_SECRET, issuer `pulse:oidc`, subject = the app
 * user's `users.supabaseId` (namespaced `oidc:<sub>`). This token is
 * accepted alongside the auth backend's tokens by `resolveTokenIdentity`
 * (db/queries/users.ts), so it needs no cooperation from GoTrue and works
 * identically under AUTH_BACKEND=local and =supabase.
 *
 * This module is pure crypto/HTTP + `jose` — it never imports the db, so
 * it can be used from the token-verification path without an import cycle.
 */

import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  SignJWT,
  type JWTPayload
} from 'jose';

/** Issuer claim on PULSE's own OIDC session tokens. */
export const OIDC_SESSION_ISSUER = 'pulse:oidc';
/** Issuer claim on the short-lived signed state cookie. */
const OIDC_STATE_ISSUER = 'pulse:oidc-state';
/** Name of the HttpOnly cookie holding the signed flow state. */
export const OIDC_STATE_COOKIE = 'pulse_oidc_state';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const STATE_TTL_SECONDS = 10 * 60;

export type OidcConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  label: string;
  /** Explicit redirect URI override; otherwise derived from the request. */
  redirectUriOverride?: string;
};

/**
 * Read + validate OIDC config from the environment. Returns null (OIDC
 * disabled) unless every prerequisite is present, so callers can treat a
 * null as "don't advertise / 404 the routes" without re-checking each var.
 * AUTH_SECRET is required because the session token is signed with it.
 */
export function getOidcConfig(): OidcConfig | null {
  if (process.env.OIDC_OAUTH_ENABLED !== 'true') return null;

  const issuer = process.env.OIDC_ISSUER?.trim();
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  const clientSecret = process.env.OIDC_SECRET?.trim();
  const authSecret = process.env.AUTH_SECRET;

  if (!issuer || !clientId || !clientSecret) return null;
  if (!authSecret || authSecret.length < 32) return null;

  return {
    issuer,
    clientId,
    clientSecret,
    label: process.env.OIDC_LABEL || 'Single Sign-On',
    redirectUriOverride: process.env.OIDC_REDIRECT_URI?.trim() || undefined
  };
}

function getSecret(): Uint8Array {
  const raw = process.env.AUTH_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('OIDC requires AUTH_SECRET to be set to at least 32 characters');
  }
  return new TextEncoder().encode(raw);
}

// ---------------------------------------------------------------------------
// Discovery + JWKS (cached per issuer for the process lifetime)
// ---------------------------------------------------------------------------

export type OidcDiscovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
};

const discoveryCache = new Map<string, Promise<OidcDiscovery>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function discoveryUrl(issuer: string): string {
  // The issuer may or may not carry a trailing slash; the well-known path
  // is appended without doubling it. Authentik issuers look like
  // https://host/application/o/<slug>/ and expose discovery at
  // <issuer>/.well-known/openid-configuration.
  const base = issuer.replace(/\/$/, '');
  return `${base}/.well-known/openid-configuration`;
}

export async function getDiscovery(issuer: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;

  const promise = (async () => {
    const res = await fetch(discoveryUrl(issuer), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      throw new Error(`OIDC discovery failed (${res.status}) for ${issuer}`);
    }
    const doc = (await res.json()) as Partial<OidcDiscovery>;
    if (
      !doc.issuer ||
      !doc.authorization_endpoint ||
      !doc.token_endpoint ||
      !doc.jwks_uri
    ) {
      throw new Error(`OIDC discovery document for ${issuer} is missing required fields`);
    }
    return doc as OidcDiscovery;
  })();

  // Don't cache a rejected discovery — a transient IdP outage shouldn't
  // wedge OIDC for the process lifetime.
  promise.catch(() => discoveryCache.delete(issuer));
  discoveryCache.set(issuer, promise);
  return promise;
}

function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let set = jwksCache.get(jwksUri);
  if (!set) {
    set = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, set);
  }
  return set;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random URL-safe token (used for the PKCE verifier, state, and nonce). */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64url(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Signed state cookie (stateless CSRF + PKCE binding)
// ---------------------------------------------------------------------------

export type OidcState = {
  state: string;
  verifier: string;
  nonce: string;
  redirectUri: string;
  invite?: string;
};

export async function signState(payload: OidcState): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(OIDC_STATE_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS)
    .sign(getSecret());
}

export async function verifyState(token: string): Promise<OidcState | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: OIDC_STATE_ISSUER
    });
    const p = payload as JWTPayload & Partial<OidcState>;
    if (
      typeof p.state !== 'string' ||
      typeof p.verifier !== 'string' ||
      typeof p.nonce !== 'string' ||
      typeof p.redirectUri !== 'string'
    ) {
      return null;
    }
    return {
      state: p.state,
      verifier: p.verifier,
      nonce: p.nonce,
      redirectUri: p.redirectUri,
      invite: typeof p.invite === 'string' ? p.invite : undefined
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authorize URL + token exchange + id_token verification
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(
  config: OidcConfig,
  discovery: OidcDiscovery,
  opts: { redirectUri: string; state: string; challenge: string; nonce: string }
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', opts.redirectUri);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', opts.state);
  url.searchParams.set('nonce', opts.nonce);
  url.searchParams.set('code_challenge', opts.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

type TokenResponse = { id_token?: string; access_token?: string };

export async function exchangeCode(
  config: OidcConfig,
  discovery: OidcDiscovery,
  opts: { code: string; redirectUri: string; verifier: string }
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.verifier,
    client_id: config.clientId
  });

  const res = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      // Confidential client — client_secret_basic is the OIDC default and
      // what Authentik expects. client_id is also in the body for servers
      // that read it from there.
      Authorization: `Basic ${btoa(`${config.clientId}:${config.clientSecret}`)}`
    },
    body,
    signal: AbortSignal.timeout(10_000)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OIDC token exchange failed (${res.status}): ${detail.slice(0, 200)}`);
  }
  return (await res.json()) as TokenResponse;
}

export type OidcClaims = {
  sub: string;
  email: string | null;
  name?: string;
};

export async function verifyIdToken(
  config: OidcConfig,
  discovery: OidcDiscovery,
  idToken: string,
  expectedNonce: string
): Promise<OidcClaims> {
  const { payload } = await jwtVerify(idToken, getJwks(discovery.jwks_uri), {
    issuer: discovery.issuer,
    audience: config.clientId
  });

  if (payload.nonce !== expectedNonce) {
    throw new Error('OIDC id_token nonce mismatch');
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new Error('OIDC id_token has no subject');
  }

  const email = typeof payload.email === 'string' ? payload.email : null;
  const name =
    (typeof payload.name === 'string' && payload.name) ||
    (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
    (typeof payload.given_name === 'string' && payload.given_name) ||
    undefined;

  return { sub: payload.sub, email, name };
}

/** Stable `users.supabaseId` value for an OIDC subject. */
export function oidcSupabaseId(sub: string): string {
  return `oidc:${sub}`;
}

// ---------------------------------------------------------------------------
// PULSE session tokens
// ---------------------------------------------------------------------------

export async function mintSessionToken(
  supabaseId: string,
  ttlSeconds = SESSION_TTL_SECONDS
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(supabaseId)
    .setIssuer(OIDC_SESSION_ISSUER)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
    .sign(getSecret());
}

/**
 * Verify a PULSE OIDC session token. Returns the `users.supabaseId` it
 * encodes, or null if the token isn't a valid OIDC session token.
 */
export async function verifySessionToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(), {
      issuer: OIDC_SESSION_ISSUER
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Cheap, unverified check of whether a token even claims to be a PULSE
 * OIDC session token — lets the hot token-verification path skip an
 * authBackend round-trip (a network call in supabase mode) for tokens
 * that are clearly ours. The signature is still verified downstream.
 */
export function looksLikeOidcSession(token: string): boolean {
  try {
    return decodeJwt(token).iss === OIDC_SESSION_ISSUER;
  } catch {
    return false;
  }
}
