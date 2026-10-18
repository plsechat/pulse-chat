import { randomUUIDv7 } from 'bun';
import {
  SignJWT,
  jwtVerify,
  importJWK,
  exportJWK,
  generateKeyPair,
  decodeJwt,
  errors as joseErrors,
  type JWK
} from 'jose';
import { and, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { db } from '../db';
import {
  federationInstances,
  federationKeys,
  federationSeenJti
} from '../db/schema';
import { config } from '../config';
import { federationFetch, FederationRateLimitError } from './federation-fetch';
import { getFederationProtocol } from './validate-url';
import { getLogContext, newRequestId } from './log-context';
import { logger } from '../logger';

/**
 * How long a superseded key keeps verifying after a rotation — ours
 * (a retired federation_keys row) and a peer's (previous_public_key).
 * Covers relays signed just before the rotation that are still in a
 * peer's outbox, and peers that have not applied the announcement yet.
 */
const FEDERATION_KEY_GRACE_MS = 24 * 60 * 60 * 1000;

type LocalKeys = {
  id: number;
  publicKey: JWK;
  privateKey: JWK;
};

async function generateFederationKeys(): Promise<{
  id: number;
  publicKey: string;
  privateKey: string;
}> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const privateJwk = await exportJWK(privateKey);

  const publicKeyStr = JSON.stringify(publicJwk);
  const privateKeyStr = JSON.stringify(privateJwk);

  const [row] = await db
    .insert(federationKeys)
    .values({
      publicKey: publicKeyStr,
      privateKey: privateKeyStr,
      createdAt: Date.now()
    })
    .returning({ id: federationKeys.id });

  return { id: row!.id, publicKey: publicKeyStr, privateKey: privateKeyStr };
}

/**
 * The key this instance signs with: the newest row that has not been
 * retired. A retired row signs nothing but stays in the table for the
 * grace window (the seen-jti cron sweeps it afterwards) so a peer that
 * still holds our old public key can check a response we signed just
 * before rotating.
 */
async function getLocalKeys(): Promise<LocalKeys | null> {
  const [keyRecord] = await db
    .select()
    .from(federationKeys)
    .where(isNull(federationKeys.retiredAt))
    .orderBy(desc(federationKeys.id))
    .limit(1);

  if (!keyRecord) return null;

  return {
    id: keyRecord.id,
    publicKey: JSON.parse(keyRecord.publicKey) as JWK,
    privateKey: JSON.parse(keyRecord.privateKey) as JWK
  };
}

/**
 * The key retired most recently, while it is still inside the grace
 * window. A queued key-rotation announcement must be signed with it —
 * the peer it is for has only that key pinned — so the outbox resolves
 * it per attempt instead of persisting private key material in a row.
 * Null once the seen-jti cron has swept the retired row: the push can
 * no longer be honoured and the peer must be re-paired by hand.
 */
async function getRetiredSigningKeys(): Promise<LocalKeys | null> {
  const [keyRecord] = await db
    .select()
    .from(federationKeys)
    .where(isNotNull(federationKeys.retiredAt))
    .orderBy(desc(federationKeys.retiredAt), desc(federationKeys.id))
    .limit(1);

  if (
    !keyRecord ||
    keyRecord.retiredAt === null ||
    Date.now() - keyRecord.retiredAt >= FEDERATION_KEY_GRACE_MS
  ) {
    return null;
  }

  return {
    id: keyRecord.id,
    publicKey: JSON.parse(keyRecord.publicKey) as JWK,
    privateKey: JSON.parse(keyRecord.privateKey) as JWK
  };
}

/**
 * Mint a new signing key and retire the current one(s). Returns the key
 * that was live before (the rotation announcement is signed with it —
 * the only key peers can verify yet) and the new key. The new row is
 * inserted before the old is retired so a crash in between leaves two
 * live keys with the newest winning, never none.
 */
async function rotateLocalFederationKeys(): Promise<{
  previous: LocalKeys;
  next: LocalKeys;
}> {
  const previous = await getLocalKeys();
  if (!previous) {
    throw new Error('Federation keys not generated');
  }

  const generated = await generateFederationKeys();
  await db
    .update(federationKeys)
    .set({ retiredAt: Date.now() })
    .where(and(isNull(federationKeys.retiredAt), ne(federationKeys.id, generated.id)));

  return {
    previous,
    next: {
      id: generated.id,
      publicKey: JSON.parse(generated.publicKey) as JWK,
      privateKey: JSON.parse(generated.privateKey) as JWK
    }
  };
}

async function getFederationConfig(): Promise<{
  enabled: boolean;
  domain: string;
  hasKeys: boolean;
  publicKey?: string;
  allowUserFederatableServers: boolean;
}> {
  const keys = await getLocalKeys();

  return {
    enabled: config.federation.enabled,
    domain: config.federation.domain,
    hasKeys: keys !== null,
    publicKey: keys ? JSON.stringify(keys.publicKey) : undefined,
    allowUserFederatableServers: config.federation.allowUserFederatableServers
  };
}

// ─── Peer key material ───────────────────────────────────────────────────
//
// A peer's signature is checked against the key we pinned for it. After
// the peer rotates, the inbound key-rotation handler moves the old key to
// `previous_public_key` and stamps `key_rotated_at`; for the grace window
// both keys verify, so relays the peer signed before switching (or queued
// in its outbox) are not refused. Every verifier that reads
// federation_instances.public_key goes through these helpers.

type PeerKeyRow = {
  publicKey: string | null;
  previousPublicKey: string | null;
  keyRotatedAt: number | null;
};

/**
 * The public keys (JWK strings) a peer's signature may currently be
 * checked against, current key first. Pure: takes the instance row the
 * caller already has.
 */
function peerVerificationKeys(
  row: PeerKeyRow,
  now: number = Date.now()
): string[] {
  const keys: string[] = [];
  if (row.publicKey) keys.push(row.publicKey);
  if (
    row.previousPublicKey &&
    row.keyRotatedAt !== null &&
    now - row.keyRotatedAt < FEDERATION_KEY_GRACE_MS
  ) {
    keys.push(row.previousPublicKey);
  }
  return keys;
}

/**
 * `peerVerificationKeys` for an ACTIVE peer looked up by domain. Empty
 * when the domain is unknown, not active, or has no key on file — the
 * caller treats that as "cannot verify".
 */
async function getPeerVerificationKeys(domain: string): Promise<string[]> {
  const [instance] = await db
    .select({
      publicKey: federationInstances.publicKey,
      previousPublicKey: federationInstances.previousPublicKey,
      keyRotatedAt: federationInstances.keyRotatedAt
    })
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, domain),
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  return instance ? peerVerificationKeys(instance) : [];
}

/**
 * Peers' clocks drift. A minute of tolerance on `exp`/`nbf`/`iat` keeps
 * a receiver that runs slightly ahead from refusing every challenge
 * with an "Invalid signature" that looks like a key problem, while a
 * replayed token still dies within the minute after its TTL.
 */
const CLOCK_TOLERANCE_S = 60;
const CLOCK_TOLERANCE_MS = CLOCK_TOLERANCE_S * 1000;

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

type VerifiedFederationToken = {
  userId: number;
  username: string;
  avatar: string | null;
  publicId: string;
  issuerDomain: string;
  instanceId: number;
};

/**
 * Why a federation token was refused. `expired` is the one case the
 * client can repair on its own (re-mint at home and reconnect); every
 * other failure — bad signature, unknown or inactive issuer, malformed
 * claims — is a peer-level rejection.
 */
type FederationTokenRejection = 'expired' | 'invalid';

type FederationTokenResult =
  | ({ ok: true } & VerifiedFederationToken)
  | { ok: false; reason: FederationTokenRejection };

async function verifyFederationTokenDetailed(
  token: string
): Promise<FederationTokenResult> {
  const rejected = (reason: FederationTokenRejection): FederationTokenResult => ({
    ok: false,
    reason
  });

  try {
    logger.debug('[verifyFederationToken] verifying token, length=%d', token.length);

    // Decode without verifying to get issuer
    const decoded = decodeJwt(token);
    const issuerDomain = decoded.iss;
    logger.debug('[verifyFederationToken] issuer=%s, aud=%s, sub=%s', sanitizeForLog(issuerDomain), sanitizeForLog(decoded.aud), sanitizeForLog(decoded.sub));

    if (!issuerDomain) {
      logger.warn('[verifyFederationToken] no issuer in token');
      return rejected('invalid');
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

    logger.debug('[verifyFederationToken] instance lookup: found=%s, status=%s, hasPublicKey=%s',
      !!instance, instance?.status, !!instance?.publicKey);

    const candidateKeys = instance ? peerVerificationKeys(instance) : [];
    if (!instance || candidateKeys.length === 0) {
      logger.warn('[verifyFederationToken] instance not found or no public key for domain=%s', sanitizeForLog(issuerDomain));
      return rejected('invalid');
    }

    // Verify the signature with the peer's pinned key, falling back to
    // its previous key inside the rotation grace window.
    logger.debug('[verifyFederationToken] verifying JWT with audience=%s', config.federation.domain);
    let payload: Record<string, unknown> | null = null;
    for (const keyStr of candidateKeys) {
      const publicKey = await importJWK(JSON.parse(keyStr) as JWK, 'EdDSA');
      try {
        const verified = await jwtVerify(token, publicKey, {
          audience: config.federation.domain,
          clockTolerance: CLOCK_TOLERANCE_S
        });
        payload = verified.payload as Record<string, unknown>;
        break;
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) {
          logger.warn(
            '[verifyFederationToken] token from %s expired at %s — client must re-mint',
            sanitizeForLog(issuerDomain),
            sanitizeForLog(String(error.payload.exp))
          );
          return rejected('expired');
        }
        if (!(error instanceof joseErrors.JWSSignatureVerificationFailed)) {
          throw error;
        }
      }
    }

    if (!payload) {
      logger.warn('[verifyFederationToken] signature from %s matches neither current nor previous key', sanitizeForLog(issuerDomain));
      return rejected('invalid');
    }

    logger.debug('[verifyFederationToken] JWT verified successfully, sub=%s, name=%s', payload.sub, payload.name);

    const publicId = (payload.publicId as string) || null;

    if (!publicId) {
      logger.warn('[verifyFederationToken] rejected token from %s: missing publicId claim', sanitizeForLog(issuerDomain));
      return rejected('invalid');
    }

    // Update lastSeenAt
    await db
      .update(federationInstances)
      .set({ lastSeenAt: Date.now() })
      .where(eq(federationInstances.id, instance.id));

    return {
      ok: true,
      userId: Number(payload.sub),
      username: payload.name as string,
      avatar: (payload.avatar as string) || null,
      publicId,
      issuerDomain,
      instanceId: instance.id
    };
  } catch (error) {
    logger.error('[verifyFederationToken] failed: %o', error);
    return rejected('invalid');
  }
}

/**
 * `verifyFederationTokenDetailed` collapsed to the verified claims or
 * null, for callers that only need "who is this" (the upload path, the
 * socket-close fallback). The WebSocket handshake uses the detailed
 * form so an expired token gets its own close code.
 */
async function verifyFederationToken(
  token: string
): Promise<VerifiedFederationToken | null> {
  const result = await verifyFederationTokenDetailed(token);
  if (!result.ok) return null;
  const { ok: _ok, ...verified } = result;
  return verified;
}

// ─── Phase 4 / F1 — wire-format hardened challenge protocol ──────────────
//
// signChallenge embeds the SHA-256 hash of the canonicalized payload in a
// `sha256` JWT claim, plus the destination as `aud`, our domain as `iss`,
// and a random `jti` for replay tracking. verifyChallenge re-canonicalizes
// the received body, recomputes the digest, and rejects mismatches; it
// also rejects unexpected issuers, audiences, expired tokens, and
// previously-seen jtis.
//
// Replay protection is anchored in the federation_seen_jti table: the
// INSERT … ON CONFLICT DO NOTHING is the atomic "seen before?" check, so
// a restart (or a second replica) does not reopen the window the way a
// process-memory set did. The in-memory map in front of it only saves a
// round trip for a replay that hits the same process; the table decides.
// A jti is retained until the signature's own `exp` plus the clock
// tolerance — past that the signature cannot verify anyway.
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

const seenJtis = new Map<string, number>();

function pruneExpiredJtis(now: number): void {
  for (const [jti, expiresAt] of seenJtis) {
    if (expiresAt < now) seenJtis.delete(jti);
  }
}

/** Test-only: drop the in-memory replay fast path so tests can exercise
 *  the same jti deterministically and prove the table still catches a
 *  replay after a "restart". Not exported through the index. */
export function _resetSeenJtis(): void {
  seenJtis.clear();
}

/**
 * Record `jti` as seen. False when it was already recorded — by this
 * process or any other one sharing the database.
 */
async function claimJti(jti: string, expiresAt: number): Promise<boolean> {
  const now = Date.now();
  pruneExpiredJtis(now);
  if (seenJtis.has(jti)) return false;

  const inserted = await db
    .insert(federationSeenJti)
    .values({ jti, expiresAt })
    .onConflictDoNothing()
    .returning({ jti: federationSeenJti.jti });

  if (inserted.length === 0) return false;

  seenJtis.set(jti, expiresAt);
  return true;
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

/**
 * Sign `payload` for `audienceDomain` with this instance's live key — or
 * with `signingKeys` when the caller must sign with a specific pair (the
 * key-rotation announcement goes out under the OLD key, the only one the
 * peer can verify until it applies the rotation).
 */
async function signChallenge(
  payload: unknown,
  audienceDomain: string,
  signingKeys?: LocalKeys
): Promise<string> {
  const keys = signingKeys ?? (await getLocalKeys());
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

/**
 * Verify a peer's challenge signature over `payload`.
 *
 * `publicKeys` is the peer's pinned key, or the list from
 * `getPeerVerificationKeys` (current first, then the previous key inside
 * the rotation grace). Keys are tried in order; only a signature that
 * verifies reaches the digest and replay checks, so a wrong first key
 * never consumes the jti.
 */
async function verifyChallenge(
  signature: string,
  payload: unknown,
  expectedIssuer: string,
  publicKeys: string | string[]
): Promise<boolean> {
  const candidates = Array.isArray(publicKeys) ? publicKeys : [publicKeys];
  if (candidates.length === 0) return false;

  try {
    let claims: Awaited<ReturnType<typeof jwtVerify>>['payload'] | null = null;
    for (const publicKeyStr of candidates) {
      const publicKey = await importJWK(
        JSON.parse(publicKeyStr) as JWK,
        'EdDSA'
      );
      try {
        const verified = await jwtVerify(signature, publicKey, {
          audience: config.federation.domain,
          issuer: expectedIssuer,
          clockTolerance: CLOCK_TOLERANCE_S
        });
        claims = verified.payload;
        break;
      } catch (error) {
        if (error instanceof joseErrors.JWTExpired) {
          // Distinct from a key problem: the sender's clock or a stale
          // outbox entry, not a mismatched pinning.
          logger.warn(
            '[verifyChallenge] signature from %s expired (exp=%s, tolerance %ds)',
            sanitizeForLog(expectedIssuer),
            sanitizeForLog(String(error.payload.exp)),
            CLOCK_TOLERANCE_S
          );
          return false;
        }
        if (!(error instanceof joseErrors.JWSSignatureVerificationFailed)) {
          throw error;
        }
      }
    }
    if (!claims) return false;

    // Body-hash binding: re-canonicalize the received body and compare.
    // Without this, a peer signature is reusable against any other body
    // that the same key signed before.
    const expectedDigest = await payloadDigest(payload);
    const claimedDigest = (claims as Record<string, unknown>).sha256;
    if (typeof claimedDigest !== 'string' || claimedDigest !== expectedDigest) {
      return false;
    }

    // Replay protection: jti must be unique for as long as the signature
    // can still verify — claims.exp is seconds, we store ms.
    if (typeof claims.jti !== 'string' || !claims.exp) return false;

    return claimJti(claims.jti, claims.exp * 1000 + CLOCK_TOLERANCE_MS);
  } catch {
    return false;
  }
}

// Test-only re-export so the unit tests can poke the canonicalizer +
// digest without going through the full sign/verify dance.
export const _challengeInternals = {
  canonicalize,
  payloadDigest,
  CHALLENGE_TTL_MS,
  CLOCK_TOLERANCE_MS
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
 * public key(s), and returns the verified payload (without `signature`)
 * or null on any failure.
 *
 * Pulled out of `queryInstance` so the verification path is unit-
 * testable without going through `federationFetch`.
 */
async function verifyFederationResponse(
  responseBody: Record<string, unknown>,
  expectedPeerDomain: string,
  peerPublicKeys: string | string[]
): Promise<Record<string, unknown> | null> {
  const { signature, ...payload } = responseBody;
  if (typeof signature !== 'string') return null;

  const isValid = await verifyChallenge(
    signature,
    payload,
    expectedPeerDomain,
    peerPublicKeys
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
 * 3. Read the response JSON (bounded by federationFetch's body cap).
 * 4. Look up the remote instance's stored federation public key(s).
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
    const protocol = getFederationProtocol(instanceDomain);

    const bodyToSign = {
      ...payload,
      fromDomain: config.federation.domain
    };
    const signature = await signChallenge(bodyToSign, instanceDomain);
    const requestBody = { ...bodyToSign, signature };

    const requestId = getLogContext()?.requestId ?? newRequestId();
    logger.debug(
      '[queryInstance] > %s%s requestId=%s',
      instanceDomain,
      path,
      requestId
    );
    const startMs = performance.now();
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
    const durationMs = (performance.now() - startMs).toFixed(2);

    if (!response.ok) {
      logger.warn(
        '[queryInstance] %s%s returned %d (%sms)',
        instanceDomain,
        path,
        response.status,
        durationMs
      );
      return null;
    }

    logger.debug(
      '[queryInstance] < %s%s %d %sms',
      instanceDomain,
      path,
      response.status,
      durationMs
    );

    const responseJson = await response.json<Record<string, unknown>>();

    const peerKeys = await getPeerVerificationKeys(instanceDomain);

    if (peerKeys.length === 0) {
      logger.warn(
        '[queryInstance] no public key on file for %s — cannot verify response',
        instanceDomain
      );
      return null;
    }

    const verified = await verifyFederationResponse(
      responseJson,
      instanceDomain,
      peerKeys
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

// ─── Relays ──────────────────────────────────────────────────────────────

/**
 * Outcome of one relay attempt. `unsupported` is a 404: the peer runs
 * a version without that route, so retrying is pointless (the outbox
 * dead-letters such rows at once). `error` is the short reason stored
 * on the instance row for the operator's panel.
 */
type RelayOutcome = {
  ok: boolean;
  status?: number;
  unsupported?: boolean;
  /** Either our own outbound per-host limiter refused the call (nothing
   *  was sent) or the peer answered 429: retry after the budget refills
   *  and do not count it as a delivery failure of the peer. */
  rateLimited?: boolean;
  /** The peer's `Retry-After` on a 429, in ms (bounded). */
  retryAfterMs?: number;
  error?: string;
};

/** Longest a peer's Retry-After is honoured; beyond it the outbox backs off on its own. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

type RelayOptions = {
  /** Sign with this pair instead of the live key (key-rotation push). */
  signingKeys?: LocalKeys;
};

/** Longest `last_error` stored on an instance row. */
const MAX_LAST_ERROR_LENGTH = 200;

/**
 * Mirror the outcome onto federation_instances.last_error so a peer
 * that keeps failing — or that answers 404 because it is behind on the
 * protocol — is visible to the instance owner instead of only in the
 * log. Cleared on the next success. Best effort: a DB hiccup here must
 * not turn a delivered relay into a reported failure.
 */
async function recordRelayOutcome(
  instanceDomain: string,
  outcome: RelayOutcome
): Promise<void> {
  try {
    if (outcome.ok) {
      await db
        .update(federationInstances)
        .set({ lastError: null, lastErrorAt: null })
        .where(
          and(
            eq(federationInstances.domain, instanceDomain),
            isNotNull(federationInstances.lastError)
          )
        );
      return;
    }

    await db
      .update(federationInstances)
      .set({
        lastError: (outcome.error ?? 'failed').slice(0, MAX_LAST_ERROR_LENGTH),
        lastErrorAt: Date.now()
      })
      .where(eq(federationInstances.domain, instanceDomain));
  } catch (error) {
    logger.debug(
      '[relayToInstance] could not record outcome for %s: %o',
      instanceDomain,
      error
    );
  }
}

/**
 * POST a signed relay body to a peer and report what happened. The
 * outbox and the key-rotation push need the kind of failure (a 404 is
 * terminal, a timeout is retryable); `relayToInstance` below keeps the
 * boolean surface every existing dispatcher was written against.
 */
async function relayToInstanceDetailed(
  instanceDomain: string,
  path: string,
  payload: Record<string, unknown>,
  options: RelayOptions = {}
): Promise<RelayOutcome> {
  let outcome: RelayOutcome;
  try {
    const protocol = getFederationProtocol(instanceDomain);

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
    const signature = await signChallenge(
      bodyToSign,
      instanceDomain,
      options.signingKeys
    );

    const body = {
      ...bodyToSign,
      signature
    };

    const requestId = getLogContext()?.requestId ?? newRequestId();
    logger.debug(
      '[relayToInstance] > %s%s requestId=%s',
      instanceDomain,
      path,
      requestId
    );
    const startMs = performance.now();
    const response = await federationFetch(`${protocol}://${instanceDomain}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pulse-Request-Id': requestId
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000)
    });
    const durationMs = (performance.now() - startMs).toFixed(2);

    if (!response.ok) {
      logger.warn(
        '[relayToInstance] %s%s returned %d (%sms)',
        instanceDomain,
        path,
        response.status,
        durationMs
      );
      const unsupported = response.status === 404;
      outcome = {
        ok: false,
        status: response.status,
        unsupported,
        error: unsupported ? `unsupported:${path}` : `http:${response.status}`
      };
      if (response.status === 429) {
        // The peer's per-peer budget: not a failure of the peer, and it
        // says when to come back.
        outcome.rateLimited = true;
        const retryAfterSec = Number.parseInt(
          response.headers.get('retry-after') ?? '',
          10
        );
        if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
          outcome.retryAfterMs = Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
        }
      }
    } else {
      logger.debug(
        '[relayToInstance] < %s%s %d %sms',
        instanceDomain,
        path,
        response.status,
        durationMs
      );
      outcome = { ok: true, status: response.status };
    }
  } catch (error) {
    logger.error('[relayToInstance] failed to relay to %s%s: %o', instanceDomain, path, error);
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    outcome = { ok: false, error: message };
    if (error instanceof FederationRateLimitError) outcome.rateLimited = true;
  }

  await recordRelayOutcome(instanceDomain, outcome);
  return outcome;
}

async function relayToInstance(
  instanceDomain: string,
  path: string,
  payload: Record<string, unknown>
): Promise<boolean> {
  const outcome = await relayToInstanceDetailed(instanceDomain, path, payload);
  return outcome.ok;
}

export {
  FEDERATION_KEY_GRACE_MS,
  generateFederationKeys,
  generateFederationToken,
  getFederationConfig,
  getLocalKeys,
  getPeerVerificationKeys,
  getRetiredSigningKeys,
  peerVerificationKeys,
  queryInstance,
  relayToInstance,
  relayToInstanceDetailed,
  rotateLocalFederationKeys,
  signChallenge,
  signFederationResponse,
  signedJsonResponse,
  verifyChallenge,
  verifyFederationResponse,
  verifyFederationToken,
  verifyFederationTokenDetailed,
  type FederationTokenResult,
  type LocalKeys,
  type RelayOutcome
};
