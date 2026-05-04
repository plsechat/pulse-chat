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

    const response = await federationFetch(`${protocol}://${instanceDomain}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
  relayToInstance,
  signChallenge,
  verifyChallenge,
  verifyFederationToken
};
