import { randomUUIDv7 } from 'bun';
import {
  SignJWT,
  jwtVerify,
  importJWK,
  exportJWK,
  generateKeyPair,
  decodeJwt,
  type JWK
} from 'jose';
import { and, eq } from 'drizzle-orm';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { db } from '../db';
import { federationInstances, federationKeys } from '../db/schema';
import { config } from '../config';
import { federationFetch } from './federation-fetch';
import { getLogContext, newRequestId } from './log-context';
import { logger } from '../logger';

async function generateFederationKeys(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  const publicKeyStr = JSON.stringify(publicJwk);
  const privateKeyStr = JSON.stringify(privateJwk);

  await db.insert(federationKeys).values({
    publicKey: publicKeyStr,
    privateKey: privateKeyStr,
    createdAt: Date.now()
  });

  return { publicKey: publicKeyStr, privateKey: privateKeyStr };
}

async function getLocalKeys(): Promise<{
  publicKey: JWK;
  privateKey: JWK;
} | null> {
  const [keyRecord] = await db
    .select()
    .from(federationKeys)
    .orderBy(federationKeys.id)
    .limit(1);

  if (!keyRecord) return null;

  return {
    publicKey: JSON.parse(keyRecord.publicKey) as JWK,
    privateKey: JSON.parse(keyRecord.privateKey) as JWK
  };
}

async function getFederationConfig(): Promise<{
  enabled: boolean;
  domain: string;
  hasKeys: boolean;
  publicKey?: string;
}> {
  const keys = await getLocalKeys();

  return {
    enabled: config.federation.enabled,
    domain: config.federation.domain,
    hasKeys: keys !== null,
    publicKey: keys ? JSON.stringify(keys.publicKey) : undefined
  };
}

async function generateFederationToken(
  userId: number,
  username: string,
  targetDomain: string,
  avatar?: string | null,
  publicId?: string | null
): Promise<string> {
  const keys = await getLocalKeys();

  if (!keys) {
    throw new Error('Federation keys not generated');
  }

  const domain = config.federation.domain;
  const privateKey = await importJWK(keys.privateKey, 'EdDSA');

  return new SignJWT({
    sub: String(userId),
    name: username,
    avatar: avatar || null,
    publicId: publicId || null
  })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(domain)
    .setAudience(targetDomain)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(privateKey);
}

async function verifyFederationToken(token: string): Promise<{
  userId: number;
  username: string;
  avatar: string | null;
  publicId: string;
  issuerDomain: string;
  instanceId: number;
} | null> {
  try {
    logger.info('[verifyFederationToken] verifying token, length=%d', token.length);

    // Decode without verifying to get issuer
    const decoded = decodeJwt(token);
    const issuerDomain = decoded.iss;
    logger.info('[verifyFederationToken] issuer=%s, aud=%s, sub=%s', sanitizeForLog(issuerDomain), sanitizeForLog(decoded.aud), sanitizeForLog(decoded.sub));

    if (!issuerDomain) {
      logger.warn('[verifyFederationToken] no issuer in token');
      return null;
    }

    // Look up issuer in federationInstances (must be 'active')
    const [instance] = await db
      .select()
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.domain, issuerDomain),
          eq(federationInstances.status, 'active')
        )
      )
      .limit(1);

    logger.info('[verifyFederationToken] instance lookup: found=%s, status=%s, hasPublicKey=%s',
      !!instance, instance?.status, !!instance?.publicKey);

    if (!instance || !instance.publicKey) {
      logger.warn('[verifyFederationToken] instance not found or no public key for domain=%s', issuerDomain);
      return null;
    }

    // Verify signature with instance's stored public key
    const publicKey = await importJWK(
      JSON.parse(instance.publicKey) as JWK,
      'EdDSA'
    );
    logger.info('[verifyFederationToken] verifying JWT with audience=%s', config.federation.domain);
    const { payload } = await jwtVerify(token, publicKey, {
      audience: config.federation.domain
    });
    logger.info('[verifyFederationToken] JWT verified successfully, sub=%s, name=%s', payload.sub, (payload as Record<string, unknown>).name);

    const publicId = ((payload as Record<string, unknown>).publicId as string) || null;

    if (!publicId) {
      logger.warn('[verifyFederationToken] rejected token from %s: missing publicId claim', issuerDomain);
      return null;
    }

    // Update lastSeenAt
    await db
      .update(federationInstances)
      .set({ lastSeenAt: Date.now() })
      .where(eq(federationInstances.id, instance.id));

    return {
      userId: Number(payload.sub),
      username: (payload as Record<string, unknown>).name as string,
      avatar: ((payload as Record<string, unknown>).avatar as string) || null,
      publicId,
      issuerDomain,
      instanceId: instance.id
    };
  } catch (error) {
    logger.error('[verifyFederationToken] failed: %o', error);
    return null;
  }
}

// ─── Phase 4 / F1 — wire-format hardened challenge protocol ──────────────
//
// signChallenge embeds the SHA-256 hash of the canonicalized payload in a
// `sha256` JWT claim, plus the destination as `aud`, our domain as `iss`,
// and a random `jti` for replay tracking. verifyChallenge re-canonicalizes
// the received body, recomputes the digest, and rejects mismatches; it
// also rejects unexpected issuers, audiences, expired tokens, and
// previously-seen jtis (within a 10-minute retention window covering the
// 5-minute signing TTL plus clock skew).
//
// Wire-format BREAKING vs. v0.1.x: a peer running pre-v0.2 code will fail
// every verify against a v0.2 signature because the old verifier doesn't
// look at sha256/iss/aud/jti and the old signer doesn't emit them. Both
// sides must upgrade for federation to work.
//
// Canonicalization: we recursively sort object keys alphabetically before
// JSON.stringify so sender and receiver produce identical bytes for the
// same logical payload regardless of insertion order. Arrays preserve
// order. Primitives pass through.

const CHALLENGE_TTL = '5m';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Replay window — a bit larger than TTL to cover clock skew between peers.
const JTI_RETENTION_MS = 10 * 60 * 1000;

const seenJtis = new Map<string, number>();

function pruneExpiredJtis(now: number): void {
  for (const [jti, expiresAt] of seenJtis) {
    if (expiresAt < now) seenJtis.delete(jti);
  }
}

/** Test-only: drop the in-memory replay set so tests can exercise the
 *  same jti deterministically. Not exported through the index — only
 *  imported by `__tests__/federation-challenge.test.ts`. */
export function _resetSeenJtis(): void {
  seenJtis.clear();
}

function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) {
      return val;
    }
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(val as Record<string, unknown>).sort()) {
      sorted[k] = (val as Record<string, unknown>)[k];
    }
    return sorted;
  });
}

async function payloadDigest(payload: unknown): Promise<string> {
  const canonical = canonicalize(payload);
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical)
  );
  // base64url, no padding
  return Buffer.from(buf).toString('base64url');
}

async function signChallenge(
  payload: unknown,
  audienceDomain: string
): Promise<string> {
  const keys = await getLocalKeys();
  if (!keys) {
    throw new Error('Federation keys not generated');
  }

  const privateKey = await importJWK(keys.privateKey, 'EdDSA');
  const sha256 = await payloadDigest(payload);

  return new SignJWT({ sha256 })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(config.federation.domain)
    .setAudience(audienceDomain)
    .setJti(randomUUIDv7())
    .setIssuedAt()
    .setExpirationTime(CHALLENGE_TTL)
    .sign(privateKey);
}

async function verifyChallenge(
  signature: string,
  payload: unknown,
  expectedIssuer: string,
  publicKeyStr: string
): Promise<boolean> {
  try {
    const publicKey = await importJWK(
      JSON.parse(publicKeyStr) as JWK,
      'EdDSA'
    );

    const { payload: claims } = await jwtVerify(signature, publicKey, {
      audience: config.federation.domain,
      issuer: expectedIssuer
    });

    // Body-hash binding: re-canonicalize the received body and compare.
    // Without this, a peer signature is reusable against any other body
    // that the same key signed before.
    const expectedDigest = await payloadDigest(payload);
    const claimedDigest = (claims as Record<string, unknown>).sha256;
    if (typeof claimedDigest !== 'string' || claimedDigest !== expectedDigest) {
      return false;
    }

    // Replay protection: jti must be unique within the retention window.
    if (typeof claims.jti !== 'string' || !claims.exp) return false;

    const now = Date.now();
    pruneExpiredJtis(now);
    if (seenJtis.has(claims.jti)) return false;

    // Retain past the signature's exp so a replay arriving right at the
    // edge still gets caught — claims.exp is seconds, we store ms.
    seenJtis.set(claims.jti, now + JTI_RETENTION_MS);

    return true;
  } catch {
    return false;
  }
}

// Test-only re-export so the unit tests can poke the canonicalizer +
// digest without going through the full sign/verify dance.
export const _challengeInternals = {
  canonicalize,
  payloadDigest,
  CHALLENGE_TTL_MS
};

/**
 * Test-only: sign a payload claiming to be from `issuerDomain` using
 * an arbitrary private JWK. Production code uses `signChallenge`,
 * which is hard-wired to this instance's identity (iss = our domain,
 * private key = our key). Tests use this helper to fabricate signed
 * federation requests AS IF they came from a peer — required to
 * exercise the inbound federation HTTP handlers without spinning up
 * a second test instance.
 *
 * The receiver's `verifyChallenge` will accept the signature when:
 *   - the federation_instances row for `issuerDomain` has its
 *     `publicKey` field set to the matching public JWK (test seeds
 *     this), AND
 *   - `audienceDomain` matches the receiver's local domain.
 */
export async function _signChallengeAs(
  payload: unknown,
  issuerDomain: string,
  audienceDomain: string,
  privateKeyJwk: JWK
): Promise<string> {
  const privateKey = await importJWK(privateKeyJwk, 'EdDSA');
  const sha256 = await payloadDigest(payload);

  return new SignJWT({ sha256 })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(issuerDomain)
    .setAudience(audienceDomain)
    .setJti(randomUUIDv7())
    .setIssuedAt()
    .setExpirationTime(CHALLENGE_TTL)
    .sign(privateKey);
}

// ─── Phase D / D0 — signed federation responses ──────────────────────────
//
// `signChallenge` / `verifyChallenge` above protect REQUESTS (sender ⇒
// receiver). Federation responses on existing routes (dm-relay, member-
// add, etc.) are TLS-only — fine when the response body is just an ack,
// but not fine the moment a federation response carries security-
// sensitive data (e.g. the cross-instance pre-key bundles introduced in
// Phase D1). An active attacker between the requester's home and the
// responding peer could substitute key material in the response under
// TLS-only protection.
//
// `signFederationResponse` + `verifyFederationResponse` extend the same
// JWT challenge protocol to the response direction: the responder signs
// the response body bound to the original requester's domain (the
// `fromDomain` field that `verifyChallenge` already authenticated on the
// inbound request). The requester verifies the signature with the
// responder's stored federation public key. Audience binding stops a
// captured response signed for peer A from being replayed to peer B.
//
// Opt-in per route: existing relayToInstance handlers can keep returning
// unsigned acks. Routes that return security-critical data should use
// `signedJsonResponse` on the responder side and `queryInstance` on the
// requester side.

/**
 * Build a signed federation response body. The caller passes the
 * `requesterDomain` value extracted from the verified request's
 * `fromDomain` field — the responder commits to that audience so a
 * captured response can't be replayed against a different peer.
 *
 * Returns the wire-shaped body: { ...payload, fromDomain, signature }.
 * The responder ships this verbatim; the requester strips `signature`
 * and re-canonicalizes the rest before verifying.
 */
async function signFederationResponse(
  payload: Record<string, unknown>,
  requesterDomain: string
): Promise<Record<string, unknown>> {
  const bodyToSign = {
    ...payload,
    fromDomain: config.federation.domain
  };
  const signature = await signChallenge(bodyToSign, requesterDomain);
  return { ...bodyToSign, signature };
}

/**
 * HTTP wrapper for `signFederationResponse`. Replaces `jsonResponse`
 * for federation handlers that return security-critical data.
 */
async function signedJsonResponse(
  res: import('node:http').ServerResponse,
  status: number,
  payload: Record<string, unknown>,
  requesterDomain: string
): Promise<void> {
  const signedBody = await signFederationResponse(payload, requesterDomain);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(signedBody));
}

/**
 * Verify a signed federation response body. Strips `signature` from
 * the wire body, runs `verifyChallenge` against the responder's stored
 * public key, and returns the verified payload (without `signature`)
 * or null on any failure.
 *
 * Pulled out of `queryInstance` so the verification path is unit-
 * testable without going through `federationFetch`.
 */
async function verifyFederationResponse(
  responseBody: Record<string, unknown>,
  expectedPeerDomain: string,
  peerPublicKeyStr: string
): Promise<Record<string, unknown> | null> {
  const { signature, ...payload } = responseBody;
  if (typeof signature !== 'string') return null;

  const isValid = await verifyChallenge(
    signature,
    payload,
    expectedPeerDomain,
    peerPublicKeyStr
  );
  return isValid ? payload : null;
}

/**
 * Parallel to `relayToInstance`, but for request/response federation
 * calls where the response body carries security-sensitive data
 * (Phase D1 pre-key bundles, identity-rotation acks, etc).
 *
 * Behaviour:
 * 1. Sign the request body (audience = remote instance).
 * 2. POST it.
 * 3. Read the response JSON.
 * 4. Look up the remote instance's stored federation public key.
 * 5. Verify the response body's `signature` against that key, with
 *    issuer = the remote instance and audience = our own domain (the
 *    audience check is enforced inside `verifyChallenge` against
 *    `config.federation.domain`).
 * 6. Return the verified payload (without `signature`) on success,
 *    or null on any failure (network, signature, missing peer key,
 *    HTTP non-2xx). The caller decides how to surface the failure.
 */
async function queryInstance<T extends Record<string, unknown>>(
  instanceDomain: string,
  path: string,
  payload: Record<string, unknown>
): Promise<T | null> {
  try {
    const isLocalhost =
      instanceDomain.startsWith('localhost') ||
      instanceDomain.startsWith('127.0.0.1');
    const protocol = isLocalhost ? 'http' : 'https';

    const bodyToSign = {
      ...payload,
      fromDomain: config.federation.domain
    };
    const signature = await signChallenge(bodyToSign, instanceDomain);
    const requestBody = { ...bodyToSign, signature };

    const requestId = getLogContext()?.requestId ?? newRequestId();
    logger.debug(
      '[queryInstance] outbound %s%s requestId=%s',
      instanceDomain,
      path,
      requestId
    );
    const response = await federationFetch(
      `${protocol}://${instanceDomain}${path}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pulse-Request-Id': requestId
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(10_000)
      }
    );

    if (!response.ok) {
      logger.warn(
        '[queryInstance] %s%s returned %d',
        instanceDomain,
        path,
        response.status
      );
      return null;
    }

    const responseJson = (await response.json()) as Record<string, unknown>;

    const [instance] = await db
      .select({ publicKey: federationInstances.publicKey })
      .from(federationInstances)
      .where(
        and(
          eq(federationInstances.domain, instanceDomain),
          eq(federationInstances.status, 'active')
        )
      )
      .limit(1);

    if (!instance?.publicKey) {
      logger.warn(
        '[queryInstance] no public key on file for %s — cannot verify response',
        instanceDomain
      );
      return null;
    }

    const verified = await verifyFederationResponse(
      responseJson,
      instanceDomain,
      instance.publicKey
    );

    if (!verified) {
      logger.warn(
        '[queryInstance] %s%s response signature invalid',
        instanceDomain,
        path
      );
      return null;
    }

    return verified as T;
  } catch (error) {
    logger.error(
      '[queryInstance] failed to query %s%s: %o',
      instanceDomain,
      path,
      error
    );
    return null;
  }
}

async function relayToInstance(
  instanceDomain: string,
  path: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  try {
    const isLocalhost =
      instanceDomain.startsWith('localhost') ||
      instanceDomain.startsWith('127.0.0.1');
    const protocol = isLocalhost ? 'http' : 'https';

    // Bind the signature to the entire wire body (every field except the
    // signature itself) and to the destination audience. The receiver
    // strips `signature`, recomputes the canonical digest, and verifies
    // it matches `sha256` in the JWT — so a relay payload signed for
    // peer A can't be replayed against peer B (different aud), and a
    // body field can't be tampered with in transit (digest mismatch).
    const bodyToSign = {
      ...payload,
      fromDomain: config.federation.domain
    };
    const signature = await signChallenge(bodyToSign, instanceDomain);

    const body = {
      ...bodyToSign,
      signature
    };

    const requestId = getLogContext()?.requestId ?? newRequestId();
    logger.debug(
      '[relayToInstance] outbound %s%s requestId=%s',
      instanceDomain,
      path,
      requestId
    );
    const response = await federationFetch(`${protocol}://${instanceDomain}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pulse-Request-Id': requestId
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      logger.warn(
        '[relayToInstance] %s%s returned %d',
        instanceDomain,
        path,
        response.status
      );
      return false;
    }

    return true;
  } catch (error) {
    logger.error('[relayToInstance] failed to relay to %s%s: %o', instanceDomain, path, error);
    return false;
  }
}

export {
  generateFederationKeys,
  generateFederationToken,
  getFederationConfig,
  getLocalKeys,
  queryInstance,
  relayToInstance,
  signChallenge,
  signFederationResponse,
  signedJsonResponse,
  verifyChallenge,
  verifyFederationResponse,
  verifyFederationToken
};
