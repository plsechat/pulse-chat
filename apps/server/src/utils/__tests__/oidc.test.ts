import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { decodeJwt, SignJWT } from 'jose';
import {
  getOidcConfig,
  looksLikeOidcSession,
  mintSessionToken,
  oidcSupabaseId,
  OIDC_SESSION_ISSUER,
  pkceChallenge,
  randomToken,
  signState,
  verifyIdToken,
  verifySessionToken,
  verifyState,
  type OidcConfig,
  type OidcDiscovery
} from '../oidc';

const ID_TOKEN_CONFIG: OidcConfig = {
  issuer: 'https://idp.example.com/application/o/pulse/',
  clientId: 'client-abc',
  clientSecret: 'client-secret-value-1234567890',
  label: 'IdP'
};

const ID_TOKEN_DISCOVERY: OidcDiscovery = {
  issuer: 'https://idp.example.com/application/o/pulse/',
  authorization_endpoint: 'https://idp.example.com/application/o/authorize/',
  token_endpoint: 'https://idp.example.com/application/o/token/',
  // Not used for HS256 verification.
  jwks_uri: 'https://idp.example.com/application/o/pulse/jwks/'
};

const signHs256IdToken = (
  claims: Record<string, unknown>,
  opts: { secret?: string; issuer?: string; audience?: string } = {}
) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('subject-1')
    .setIssuer(opts.issuer ?? ID_TOKEN_DISCOVERY.issuer)
    .setAudience(opts.audience ?? ID_TOKEN_CONFIG.clientId)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(opts.secret ?? ID_TOKEN_CONFIG.clientSecret));

const AUTH_SECRET = 'test-oidc-secret-at-least-32-chars-long!!';

describe('oidc utils', () => {
  beforeEach(() => {
    process.env.AUTH_SECRET = AUTH_SECRET;
  });

  afterEach(() => {
    delete process.env.OIDC_OAUTH_ENABLED;
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_SECRET;
    delete process.env.OIDC_LABEL;
    delete process.env.AUTH_SECRET;
  });

  describe('getOidcConfig', () => {
    const enable = () => {
      process.env.OIDC_OAUTH_ENABLED = 'true';
      process.env.OIDC_ISSUER = 'https://auth.example.com/application/o/pulse/';
      process.env.OIDC_CLIENT_ID = 'client-123';
      process.env.OIDC_SECRET = 'secret-456';
    };

    test('returns null when disabled', () => {
      enable();
      process.env.OIDC_OAUTH_ENABLED = 'false';
      expect(getOidcConfig()).toBeNull();
    });

    test('returns null when required fields missing', () => {
      process.env.OIDC_OAUTH_ENABLED = 'true';
      process.env.OIDC_ISSUER = 'https://auth.example.com/';
      // no client id / secret
      expect(getOidcConfig()).toBeNull();
    });

    test('returns null when AUTH_SECRET is missing or too short', () => {
      enable();
      process.env.AUTH_SECRET = 'too-short';
      expect(getOidcConfig()).toBeNull();
    });

    test('returns config with default label when fully set', () => {
      enable();
      const config = getOidcConfig();
      expect(config).not.toBeNull();
      expect(config!.clientId).toBe('client-123');
      expect(config!.clientSecret).toBe('secret-456');
      expect(config!.label).toBe('Single Sign-On');
    });

    test('honours a custom label', () => {
      enable();
      process.env.OIDC_LABEL = 'Authentik';
      expect(getOidcConfig()!.label).toBe('Authentik');
    });
  });

  describe('PKCE', () => {
    test('challenge is a stable url-safe S256 hash of the verifier', async () => {
      const verifier = randomToken();
      const a = await pkceChallenge(verifier);
      const b = await pkceChallenge(verifier);
      expect(a).toBe(b);
      expect(a).not.toContain('+');
      expect(a).not.toContain('/');
      expect(a).not.toContain('=');
      expect(await pkceChallenge(randomToken())).not.toBe(a);
    });

    test('randomToken is url-safe and unique', () => {
      const a = randomToken();
      const b = randomToken();
      expect(a).not.toBe(b);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('signed state cookie', () => {
    test('round-trips a valid state', async () => {
      const state = {
        state: 'abc',
        verifier: 'ver',
        nonce: 'non',
        redirectUri: 'https://pulse.example.com/auth/oidc/callback',
        invite: 'INVITE'
      };
      const token = await signState(state);
      expect(await verifyState(token)).toEqual(state);
    });

    test('rejects a tampered / wrong-secret token', async () => {
      const token = await signState({
        state: 'abc',
        verifier: 'ver',
        nonce: 'non',
        redirectUri: 'https://pulse.example.com/auth/oidc/callback'
      });
      process.env.AUTH_SECRET = 'a-different-secret-also-32-chars-xx!!';
      expect(await verifyState(token)).toBeNull();
    });

    test('rejects garbage', async () => {
      expect(await verifyState('not-a-jwt')).toBeNull();
    });
  });

  describe('session token', () => {
    test('mint + verify round-trips the supabaseId', async () => {
      const sid = oidcSupabaseId('subject-xyz');
      const token = await mintSessionToken(sid);
      expect(await verifySessionToken(token)).toBe(sid);
      expect(decodeJwt(token).iss).toBe(OIDC_SESSION_ISSUER);
      expect(looksLikeOidcSession(token)).toBe(true);
    });

    test('verify rejects a token signed with a different secret', async () => {
      const token = await mintSessionToken(oidcSupabaseId('subject-xyz'));
      process.env.AUTH_SECRET = 'a-different-secret-also-32-chars-xx!!';
      expect(await verifySessionToken(token)).toBeNull();
    });

    test('looksLikeOidcSession is false for a non-oidc jwt', async () => {
      // a token with a different issuer should not be claimed as ours
      const foreign = await signState({
        state: 's',
        verifier: 'v',
        nonce: 'n',
        redirectUri: 'https://x/cb'
      });
      expect(looksLikeOidcSession(foreign)).toBe(false);
      expect(looksLikeOidcSession('garbage')).toBe(false);
    });

    test('oidcSupabaseId namespaces the subject', () => {
      expect(oidcSupabaseId('abc')).toBe('oidc:abc');
    });
  });

  // Authentik emits HS256-signed id_tokens (HMAC with the client secret)
  // when the provider has no asymmetric signing certificate. Its JWKS is
  // then keyless, so verification must fall back to the shared secret.
  describe('verifyIdToken (HS256 / client-secret signed)', () => {
    test('verifies a valid HS256 id_token and extracts claims', async () => {
      const idToken = await signHs256IdToken({
        nonce: 'NONCE-1',
        email: 'alice@example.com',
        name: 'Alice'
      });
      const claims = await verifyIdToken(
        ID_TOKEN_CONFIG,
        ID_TOKEN_DISCOVERY,
        idToken,
        'NONCE-1'
      );
      expect(claims.sub).toBe('subject-1');
      expect(claims.email).toBe('alice@example.com');
      expect(claims.name).toBe('Alice');
    });

    test('falls back to preferred_username for the display name', async () => {
      const idToken = await signHs256IdToken({
        nonce: 'NONCE-1',
        preferred_username: 'bob'
      });
      const claims = await verifyIdToken(
        ID_TOKEN_CONFIG,
        ID_TOKEN_DISCOVERY,
        idToken,
        'NONCE-1'
      );
      expect(claims.name).toBe('bob');
      expect(claims.email).toBeNull();
    });

    test('rejects a nonce mismatch', async () => {
      const idToken = await signHs256IdToken({ nonce: 'NONCE-1' });
      await expect(
        verifyIdToken(ID_TOKEN_CONFIG, ID_TOKEN_DISCOVERY, idToken, 'OTHER')
      ).rejects.toThrow();
    });

    test('rejects a token signed with the wrong secret', async () => {
      const idToken = await signHs256IdToken(
        { nonce: 'NONCE-1' },
        { secret: 'a-totally-different-client-secret-xx' }
      );
      await expect(
        verifyIdToken(ID_TOKEN_CONFIG, ID_TOKEN_DISCOVERY, idToken, 'NONCE-1')
      ).rejects.toThrow();
    });

    test('rejects a wrong audience', async () => {
      const idToken = await signHs256IdToken(
        { nonce: 'NONCE-1' },
        { audience: 'some-other-client' }
      );
      await expect(
        verifyIdToken(ID_TOKEN_CONFIG, ID_TOKEN_DISCOVERY, idToken, 'NONCE-1')
      ).rejects.toThrow();
    });
  });
});
