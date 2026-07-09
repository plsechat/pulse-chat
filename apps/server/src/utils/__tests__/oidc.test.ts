import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { decodeJwt } from 'jose';
import {
  getOidcConfig,
  looksLikeOidcSession,
  mintSessionToken,
  oidcSupabaseId,
  OIDC_SESSION_ISSUER,
  pkceChallenge,
  randomToken,
  signState,
  verifySessionToken,
  verifyState
} from '../oidc';

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
});
