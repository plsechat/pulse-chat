/**
 * /auth/oidc/start + /auth/oidc/callback — HTTP-level tests.
 *
 * The IdP is faked by stubbing `globalThis.fetch` (restored after every
 * test — setup.ts fails the run if a stub leaks): discovery documents
 * come back for `<issuer>/.well-known/openid-configuration` and the
 * token endpoint returns an id_token signed with the client secret
 * (HS256 — the branch utils/oidc.ts takes for keyless IdPs). Everything
 * else about the flow (PKCE, state cookie, nonce) is the real code.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { invites, settings, users } from '../../db/schema';
import { OIDC_STATE_COOKIE, oidcSupabaseId, verifyState } from '../../utils/oidc';

const AUTH_SECRET = 'test-oidc-secret-at-least-32-chars-long!!';
const CLIENT_ID = 'pulse-client';
const CLIENT_SECRET = 'pulse-client-secret-for-hs256-signing';

// The test's own requests to the test server go through fetch too; the
// stub only answers the IdP's URLs and hands everything else to the real
// implementation (captured before any spy is installed).
const realFetch = globalThis.fetch;

let issuerCounter = 0;

// Discovery is cached per issuer for the process lifetime, so each test
// gets its own issuer and the fetch stub is always exercised.
const freshIssuer = () =>
  `https://idp-${++issuerCounter}.example.com/application/o/pulse/`;

const enableOidc = (issuer: string) => {
  process.env.OIDC_OAUTH_ENABLED = 'true';
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_SECRET = CLIENT_SECRET;
  process.env.AUTH_SECRET = AUTH_SECRET;
};

const discoveryFor = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}authorize/`,
  token_endpoint: `${issuer}token/`,
  jwks_uri: `${issuer}jwks/`
});

type FakeIdp = {
  /** Claims the token endpoint will sign into the id_token. */
  claims: Record<string, unknown>;
  tokenRequests: URLSearchParams[];
};

/** Stub fetch for one issuer's endpoints; returns the spy (caller restores it). */
const stubIdp = (issuer: string, idp: FakeIdp) => {
  const discovery = discoveryFor(issuer);
  return spyOn(globalThis, 'fetch').mockImplementation((async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

      if (url === `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`) {
        return Response.json(discovery);
      }

      if (url === discovery.token_endpoint) {
        const params = new URLSearchParams(String(init?.body));
        idp.tokenRequests.push(params);
        const idToken = await new SignJWT({ ...idp.claims })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer(issuer)
          .setAudience(CLIENT_ID)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode(CLIENT_SECRET));
        return Response.json({ id_token: idToken, access_token: 'at' });
      }

      return realFetch(input, init);
    }) as unknown as typeof fetch);
};

const start = (query = '') =>
  fetch(`${testsBaseUrl}/auth/oidc/start${query}`, { redirect: 'manual' });

const callback = (query: string, cookie?: string) =>
  fetch(`${testsBaseUrl}/auth/oidc/callback${query}`, {
    redirect: 'manual',
    headers: cookie ? { Cookie: cookie } : {}
  });

const cookieValue = (setCookie: string | null) => {
  const match = setCookie?.match(new RegExp(`${OIDC_STATE_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
};

/**
 * Run /start and return what a browser would hold afterwards: the state
 * cookie to send back and the decoded state the server signed into it.
 */
const beginFlow = async (query = '') => {
  const res = await start(query);
  expect(res.status).toBe(302);
  const raw = cookieValue(res.headers.get('set-cookie'));
  expect(raw).toBeTruthy();
  const state = await verifyState(raw!);
  expect(state).not.toBeNull();
  return {
    cookie: `${OIDC_STATE_COOKIE}=${encodeURIComponent(raw!)}`,
    state: state!,
    location: new URL(res.headers.get('location')!)
  };
};

describe('OIDC HTTP routes', () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
    delete process.env.OIDC_OAUTH_ENABLED;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_SECRET;
    delete process.env.OIDC_REDIRECT_URI;
    delete process.env.AUTH_SECRET;
    delete process.env.PUBLIC_URL;
    delete process.env.TRUST_PROXY;
    globalThis.__disabledRegistrationMethods = undefined;
  });

  test('both routes are 404 when OIDC is not configured', async () => {
    expect((await start()).status).toBe(404);
    expect((await callback('?code=x&state=y')).status).toBe(404);
  });

  test('/start sets a signed state cookie and redirects to the IdP with PKCE', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    fetchSpy = stubIdp(issuer, { claims: {}, tokenRequests: [] });

    const res = await start();
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location')!);
    expect(location.href.startsWith(discoveryFor(issuer).authorization_endpoint)).toBe(true);
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    // Derived from the request: plain http on the test server's Host.
    expect(location.searchParams.get('redirect_uri')).toBe(
      `${testsBaseUrl}/auth/oidc/callback`
    );

    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain(`${OIDC_STATE_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/auth/oidc');
    // Plain-http origin → no Secure flag, or the browser would drop the
    // cookie and every callback would fail "session expired".
    expect(setCookie).not.toContain('Secure');

    const state = await verifyState(cookieValue(setCookie)!);
    expect(state?.state).toBe(location.searchParams.get('state')!);
    expect(state?.nonce).toBe(location.searchParams.get('nonce')!);
    expect(state?.redirectUri).toBe(`${testsBaseUrl}/auth/oidc/callback`);
  });

  test('/start marks the cookie Secure and derives an https redirect_uri from PUBLIC_URL', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    process.env.PUBLIC_URL = 'https://pulse.example.com';
    fetchSpy = stubIdp(issuer, { claims: {}, tokenRequests: [] });

    const res = await start();
    expect(res.status).toBe(302);
    expect(res.headers.get('set-cookie')).toContain('Secure');

    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://pulse.example.com/auth/oidc/callback'
    );
  });

  test('/start honours x-forwarded-proto/host only behind a trusted proxy', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    fetchSpy = stubIdp(issuer, { claims: {}, tokenRequests: [] });
    const forwarded = {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'pulse.example.net'
    };

    // Untrusted: the headers are ignored, the origin stays the request's.
    const untrusted = await fetch(`${testsBaseUrl}/auth/oidc/start`, {
      redirect: 'manual',
      headers: forwarded
    });
    expect(untrusted.headers.get('set-cookie')).not.toContain('Secure');
    expect(
      new URL(untrusted.headers.get('location')!).searchParams.get('redirect_uri')
    ).toBe(`${testsBaseUrl}/auth/oidc/callback`);

    process.env.TRUST_PROXY = 'true';
    const trusted = await fetch(`${testsBaseUrl}/auth/oidc/start`, {
      redirect: 'manual',
      headers: forwarded
    });
    expect(trusted.headers.get('set-cookie')).toContain('Secure');
    expect(
      new URL(trusted.headers.get('location')!).searchParams.get('redirect_uri')
    ).toBe('https://pulse.example.net/auth/oidc/callback');
  });

  test('OIDC_REDIRECT_URI overrides the derived callback URL', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    process.env.OIDC_REDIRECT_URI = 'https://sso.example.org/auth/oidc/callback';
    fetchSpy = stubIdp(issuer, { claims: {}, tokenRequests: [] });

    const { location, state } = await beginFlow();
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://sso.example.org/auth/oidc/callback'
    );
    expect(state.redirectUri).toBe('https://sso.example.org/auth/oidc/callback');
  });

  test('/callback without the state cookie bounces to the SPA with an error and no token', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    fetchSpy = stubIdp(issuer, { claims: {}, tokenRequests: [] });

    const res = await callback('?code=abc&state=whatever');
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe(testsBaseUrl);
    expect(location.searchParams.get('oidc_error')).toContain('expired or invalid');
    expect(location.hash).toBe('');
    // The (absent) state cookie is cleared, without Secure on plain http.
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });

  test('/callback with a state that does not match the cookie is rejected', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    const idp: FakeIdp = { claims: { sub: 'victim' }, tokenRequests: [] };
    fetchSpy = stubIdp(issuer, idp);

    const { cookie } = await beginFlow();
    const res = await callback('?code=abc&state=not-the-one-in-the-cookie', cookie);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('oidc_error')).toContain('expired or invalid');
    expect(location.hash).toBe('');
    // The code must never have been exchanged.
    expect(idp.tokenRequests.length).toBe(0);
  });

  test('/callback with a tampered cookie is rejected', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    fetchSpy = stubIdp(issuer, { claims: {}, tokenRequests: [] });

    const { state } = await beginFlow();
    const res = await callback(
      `?code=abc&state=${state.state}`,
      `${OIDC_STATE_COOKIE}=not.a.valid.jwt`
    );
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).searchParams.get('oidc_error')).toBeTruthy();
  });

  test('/callback with ?error from the IdP reports a cancelled login', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    fetchSpy = stubIdp(issuer, { claims: {}, tokenRequests: [] });

    const { cookie } = await beginFlow();
    const res = await callback('?error=access_denied', cookie);
    expect(new URL(res.headers.get('location')!).searchParams.get('oidc_error')).toContain(
      'cancelled'
    );
  });

  test('happy path: code is exchanged with PKCE, the user is provisioned and a session lands in the fragment', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    const idp: FakeIdp = {
      claims: { sub: 'subject-42', email: 'ada@example.com', name: 'Ada' },
      tokenRequests: []
    };
    fetchSpy = stubIdp(issuer, idp);

    const { cookie, state } = await beginFlow();
    // The nonce the server put in the cookie is what the IdP echoes back.
    idp.claims.nonce = state.nonce;

    const res = await callback(`?code=the-code&state=${state.state}`, cookie);
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location')!);
    expect(location.origin).toBe(testsBaseUrl);
    expect(location.searchParams.get('oidc_error')).toBeNull();
    const fragment = new URLSearchParams(location.hash.slice(1));
    expect(fragment.get('pulse_oidc_token')).toBeTruthy();
    // Cookie cleared after use.
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');

    // Token exchange carried the PKCE verifier bound in the cookie.
    expect(idp.tokenRequests.length).toBe(1);
    expect(idp.tokenRequests[0]!.get('code')).toBe('the-code');
    expect(idp.tokenRequests[0]!.get('code_verifier')).toBe(state.verifier);
    expect(idp.tokenRequests[0]!.get('redirect_uri')).toBe(state.redirectUri);

    const [user] = await getTestDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.supabaseId, oidcSupabaseId('subject-42')))
      .limit(1);
    expect(user?.name).toBe('Ada');
  });

  test('a wrong nonce in the id_token fails the login', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    const idp: FakeIdp = {
      claims: { sub: 'subject-nonce', nonce: 'replayed-from-elsewhere' },
      tokenRequests: []
    };
    fetchSpy = stubIdp(issuer, idp);

    const { cookie, state } = await beginFlow();
    const res = await callback(`?code=the-code&state=${state.state}`, cookie);

    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('oidc_error')).toContain('Login failed');
    expect(location.hash).toBe('');

    const rows = await getTestDb()
      .select({ id: users.id })
      .from(users)
      .where(eq(users.supabaseId, oidcSupabaseId('subject-nonce')));
    expect(rows.length).toBe(0);
  });

  test('new OIDC users honour the invite policy and consume exactly one use', async () => {
    const issuer = freshIssuer();
    enableOidc(issuer);
    const tdb = getTestDb();
    await tdb.update(settings).set({ allowNewUsers: false });
    await tdb.insert(invites).values({
      code: 'OIDC-INVITE',
      creatorId: 1,
      serverId: 1,
      maxUses: 1,
      uses: 0,
      expiresAt: Date.now() + 86400000,
      createdAt: Date.now()
    });
    const idp: FakeIdp = { claims: { sub: 'invited-subject' }, tokenRequests: [] };
    fetchSpy = stubIdp(issuer, idp);

    // Without an invite: refused, no account.
    const noInvite = await beginFlow();
    idp.claims.nonce = noInvite.state.nonce;
    const refused = await callback(
      `?code=c1&state=${noInvite.state.state}`,
      noInvite.cookie
    );
    expect(new URL(refused.headers.get('location')!).searchParams.get('oidc_error')).toBeTruthy();

    // With the invite: provisioned, invite carried through, one use consumed.
    const invited = await beginFlow('?invite=OIDC-INVITE');
    idp.claims.nonce = invited.state.nonce;
    const ok = await callback(`?code=c2&state=${invited.state.state}`, invited.cookie);
    const location = new URL(ok.headers.get('location')!);
    expect(location.searchParams.get('oidc_error')).toBeNull();
    expect(location.searchParams.get('invite')).toBe('OIDC-INVITE');
    expect(new URLSearchParams(location.hash.slice(1)).get('pulse_oidc_token')).toBeTruthy();

    const [invite] = await tdb
      .select({ uses: invites.uses })
      .from(invites)
      .where(eq(invites.code, 'OIDC-INVITE'))
      .limit(1);
    expect(invite?.uses).toBe(1);
  });
});
