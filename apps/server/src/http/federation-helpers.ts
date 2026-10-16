/**
 * Shared helpers for federation HTTP handlers.
 *
 * Federation routes use a 1 MB body cap (above the generic 64 KB default
 * for app endpoints) because federation payloads can include avatar
 * blobs, signed JWT bodies, and member lists. They also share an
 * authorization prologue that verifies the signed body against the
 * sending instance's federation public key(s) and applies the per-peer
 * budget.
 *
 * Extracted from federation-dm-group.ts so every inbound route — the
 * v0.1-era social/DM routes included — runs the same primitives.
 */

import { and, eq, inArray } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { federationInstances } from '../db/schema';
import { config } from '../config';
import { peerVerificationKeys, verifyChallenge } from '../utils/federation';
import { logger } from '../logger';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import {
  consumeRateLimit,
  federationPeerDmRelayRateLimit,
  federationPeerRateLimit
} from './rate-limit-core';

const MAX_BODY_SIZE = 1024 * 1024;

/**
 * Trust-boundary caps for peer-supplied values. A federated peer is
 * authenticated, not trusted: a hostile or buggy peer must not be able
 * to grow a users/dm_messages row to the 1 MB body cap or mint shadow
 * users by the thousand. Display strings are truncated (name, bio,
 * server name); structural fields (ids, keys, arrays) are rejected.
 */
const MAX_PEER_NAME_LENGTH = 32;
const MAX_PEER_BIO_LENGTH = 500;
const MAX_PEER_PUBLIC_ID_LENGTH = 64;
const MAX_PEER_DOMAIN_LENGTH = 253;
const MAX_PEER_SERVER_NAME_LENGTH = 100;
const MAX_PEER_GROUP_NAME_LENGTH = 100;
const MAX_PEER_PUBLIC_KEY_LENGTH = 2048;
const MAX_PEER_IDENTITY_KEY_LENGTH = 128;
const MAX_PEER_DISTRIBUTION_MESSAGE_LENGTH = 16_384;
const MAX_PEER_DM_GROUP_MEMBERS = 100;
const MAX_PEER_SKDM_RECIPIENTS = 500;
const MAX_PEER_SENDER_KEY_ID = 2 ** 31 - 1;
/** Report text fields (details, excerpt) — same cap as the sender applies. */
const MAX_PEER_REPORT_TEXT_LENGTH = 1000;
/** `/public/<name>` file references (avatar names) — a bare file name only. */
const MAX_PEER_FILE_NAME_LENGTH = 128;
/** `host` or `host:port` — never a path, scheme or userinfo. */
const PEER_DOMAIN_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const PEER_BANNER_COLOR_RE = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
/** A file name as `upload` mints them: no separators, no traversal, no query. */
const PEER_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A peer-supplied display string, truncated; undefined when not a string. */
function peerString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

/**
 * A peer-supplied array of non-empty strings; undefined unless it is an
 * array of at most `maxItems` strings each at most `maxLen` long.
 */
function peerStringArray(
  v: unknown,
  maxLen: number,
  maxItems: number
): string[] | undefined {
  if (!Array.isArray(v) || v.length > maxItems) return undefined;
  if (
    !v.every(
      (item) =>
        typeof item === 'string' && item.length > 0 && item.length <= maxLen
    )
  ) {
    return undefined;
  }
  return v as string[];
}

/**
 * A peer-supplied integer within [min, max]; undefined otherwise. A
 * float, NaN, string or out-of-range value is "not sent", never coerced
 * — an id or timestamp a peer got wrong must not become a different id.
 */
function peerInteger(
  v: unknown,
  bounds: { min: number; max: number }
): number | undefined {
  return typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= bounds.min &&
    v <= bounds.max
    ? v
    : undefined;
}

/**
 * A peer-supplied `/public/` file name (avatar sync). Undefined unless it
 * is a bare file name — anything that could change the path we fetch
 * (`../`, `/`, `?`) is dropped rather than interpolated into a URL.
 */
function peerFileName(v: unknown): string | undefined {
  return typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_PEER_FILE_NAME_LENGTH &&
    PEER_FILE_NAME_RE.test(v)
    ? v
    : undefined;
}

/** A peer-supplied identifier (publicId, federationGroupId): bounded, non-empty. */
function isPeerPublicId(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_PEER_PUBLIC_ID_LENGTH
  );
}

function isPeerDomain(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.length > 0 &&
    v.length <= MAX_PEER_DOMAIN_LENGTH &&
    PEER_DOMAIN_RE.test(v)
  );
}

function isPeerSenderKeyId(v: unknown): v is number {
  return peerInteger(v, { min: 0, max: MAX_PEER_SENDER_KEY_ID }) !== undefined;
}

/**
 * A peer's federation public key as stored and verified with: bounded,
 * and the one JWK shape we ever import (Ed25519 OKP).
 */
function isPeerPublicKey(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PEER_PUBLIC_KEY_LENGTH) {
    return false;
  }
  try {
    const parsed = JSON.parse(v) as unknown;
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { kty?: unknown }).kty === 'OKP'
    );
  } catch {
    return false;
  }
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > MAX_BODY_SIZE) {
      req.resume();
      reject(new Error('Request body too large'));
      return;
    }

    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_SIZE) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown
) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Per-verified-peer budget. The IP limiter in http/index.ts is the
 * pre-auth flood brake and is shared by every peer behind one address;
 * this bucket is keyed on the authenticated `fromDomain`, so one chatty
 * peer cannot starve another and a NAT-shared address does not pool two
 * peers' budgets. DM relays get their own, tighter class: they are the
 * one route a peer's users can drive at will. Applied AFTER signature
 * verification so an unsigned flood claiming a peer's domain cannot
 * drain that peer's budget. On refusal the 429 carries `Retry-After`,
 * which the peer's outbox honours.
 */
type PeerRateLimitClass = 'general' | 'dmRelay';

function checkPeerRateLimit(
  res: http.ServerResponse,
  fromDomain: string,
  cls: PeerRateLimitClass
): boolean {
  const result = consumeRateLimit(
    `peer:${cls}:${fromDomain}`,
    cls === 'dmRelay' ? federationPeerDmRelayRateLimit : federationPeerRateLimit
  );
  if (result.allowed) return true;

  logger.warn(
    '[federation] peer %s over its %s budget, retry in %ds',
    sanitizeForLog(fromDomain),
    cls,
    result.retryAfterSec
  );
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(result.retryAfterSec)
  });
  res.end(JSON.stringify({ error: 'Peer rate limit exceeded' }));
  return false;
}

type PeerInstanceStatus = 'active' | 'pending' | 'blocked';

type AuthorizeOptions = {
  /**
   * Instance statuses the route accepts. Default: active only. The
   * peering handshake (`/federation/accept`) must hear from a peer whose
   * row is still pending; `/federation/unpeer` must stay idempotent
   * after the row was already blocked.
   */
  statuses?: PeerInstanceStatus[];
  /** Budget class — `dmRelay` for the message relay, else `general`. */
  limit?: PeerRateLimitClass;
  /**
   * Body field to take the sender's domain from when `fromDomain` is
   * absent. Peers from before the accept route verified the full body
   * signed `{ domain }` alone.
   */
  fallbackSenderField?: string;
};

type AuthorizedFederationRequest = {
  instance: {
    id: number;
    publicKey: string;
    domain: string;
    status: string;
    direction: string;
  };
  signedBody: Record<string, unknown>;
  fromDomain: string;
};

/**
 * Common request prologue for signed federation routes:
 *   - federation enabled check
 *   - body parse
 *   - sender instance lookup by `fromDomain`
 *   - signature verification against the peer's pinned key (and its
 *     previous key inside the rotation grace window)
 *   - per-peer rate limit
 *
 * On success returns `{ instance, signedBody, fromDomain }`. On any
 * failure, sends a 4xx response and returns null — callers should
 * just `if (!auth) return;`.
 */
async function authorizeFederationRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: AuthorizeOptions = {}
): Promise<AuthorizedFederationRequest | null> {
  if (!config.federation.enabled) {
    logger.debug('[federation] %s rejected — federation disabled', req.url);
    jsonResponse(res, 403, { error: 'Federation not enabled' });
    return null;
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain =
    signedBody.fromDomain ??
    (opts.fallbackSenderField ? signedBody[opts.fallbackSenderField] : undefined);

  if (!isPeerDomain(fromDomain) || !signature || typeof signature !== 'string') {
    logger.debug(
      '[federation] %s rejected — missing fromDomain or signature',
      req.url
    );
    jsonResponse(res, 400, { error: 'Missing fromDomain or signature' });
    return null;
  }

  const [instance] = await db
    .select()
    .from(federationInstances)
    .where(
      and(
        eq(federationInstances.domain, fromDomain),
        inArray(federationInstances.status, opts.statuses ?? ['active'])
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    logger.debug(
      '[federation] %s rejected — peer %s not trusted',
      req.url,
      sanitizeForLog(fromDomain)
    );
    jsonResponse(res, 403, { error: 'Not a trusted instance' });
    return null;
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    peerVerificationKeys(instance)
  );
  if (!isValid) {
    logger.warn(
      '[federation] %s rejected — invalid signature from %s',
      req.url,
      sanitizeForLog(fromDomain)
    );
    jsonResponse(res, 401, { error: 'Invalid signature' });
    return null;
  }

  if (!checkPeerRateLimit(res, fromDomain, opts.limit ?? 'general')) {
    return null;
  }

  logger.debug(
    '[federation] > %s from %s (instanceId=%d)',
    req.url,
    sanitizeForLog(fromDomain),
    instance.id
  );

  return {
    instance: {
      id: instance.id,
      publicKey: instance.publicKey,
      domain: instance.domain,
      status: instance.status,
      direction: instance.direction
    },
    signedBody,
    fromDomain
  };
}

export {
  MAX_BODY_SIZE,
  MAX_PEER_BIO_LENGTH,
  MAX_PEER_DISTRIBUTION_MESSAGE_LENGTH,
  MAX_PEER_DM_GROUP_MEMBERS,
  MAX_PEER_DOMAIN_LENGTH,
  MAX_PEER_GROUP_NAME_LENGTH,
  MAX_PEER_IDENTITY_KEY_LENGTH,
  MAX_PEER_NAME_LENGTH,
  MAX_PEER_PUBLIC_ID_LENGTH,
  MAX_PEER_PUBLIC_KEY_LENGTH,
  MAX_PEER_REPORT_TEXT_LENGTH,
  MAX_PEER_SERVER_NAME_LENGTH,
  MAX_PEER_SKDM_RECIPIENTS,
  PEER_BANNER_COLOR_RE,
  PEER_DOMAIN_RE,
  parseBody,
  jsonResponse,
  authorizeFederationRequest,
  checkPeerRateLimit,
  isPeerDomain,
  isPeerPublicId,
  isPeerPublicKey,
  isPeerSenderKeyId,
  peerFileName,
  peerInteger,
  peerString,
  peerStringArray,
  type AuthorizedFederationRequest
};
