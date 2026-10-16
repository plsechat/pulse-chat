/**
 * Shared helpers for federation HTTP handlers.
 *
 * Federation routes use a 1 MB body cap (above the generic 64 KB default
 * for app endpoints) because federation payloads can include avatar
 * blobs, signed JWT bodies, and member lists. They also share an
 * authorization prologue that verifies the signed body against the
 * sending instance's federation public key.
 *
 * Extracted from federation-dm-group.ts so Phase E (channel state,
 * user-info push, channel SKDM) handlers can reuse the same primitives
 * without duplicating.
 */

import { and, eq } from 'drizzle-orm';
import http from 'http';
import { db } from '../db';
import { federationInstances } from '../db/schema';
import { config } from '../config';
import { verifyChallenge } from '../utils/federation';
import { logger } from '../logger';

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
/** `host` or `host:port` — never a path, scheme or userinfo. */
const PEER_DOMAIN_RE = /^[a-z0-9.-]+(:\d{1,5})?$/i;
const PEER_BANNER_COLOR_RE = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;

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
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= MAX_PEER_SENDER_KEY_ID
  );
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
 * Common request prologue for signed federation routes:
 *   - federation enabled check
 *   - body parse
 *   - sender instance lookup by `fromDomain`
 *   - signature verification
 *
 * On success returns `{ instance, signedBody, fromDomain }`. On any
 * failure, sends a 4xx response and returns null — callers should
 * just `if (!auth) return;`.
 */
async function authorizeFederationRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<
  | {
      instance: { id: number; publicKey: string; domain: string };
      signedBody: Record<string, unknown>;
      fromDomain: string;
    }
  | null
> {
  if (!config.federation.enabled) {
    logger.debug('[federation] %s rejected — federation disabled', req.url);
    jsonResponse(res, 403, { error: 'Federation not enabled' });
    return null;
  }

  const body = await parseBody(req);
  const { signature, ...signedBody } = body as Record<string, unknown> & {
    signature: string;
  };
  const fromDomain = signedBody.fromDomain as string;

  if (!fromDomain || !signature || typeof signature !== 'string') {
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
        eq(federationInstances.status, 'active')
      )
    )
    .limit(1);

  if (!instance || !instance.publicKey) {
    logger.debug(
      '[federation] %s rejected — peer %s not trusted',
      req.url,
      fromDomain
    );
    jsonResponse(res, 403, { error: 'Not a trusted instance' });
    return null;
  }

  const isValid = await verifyChallenge(
    signature,
    signedBody,
    fromDomain,
    instance.publicKey
  );
  if (!isValid) {
    logger.warn(
      '[federation] %s rejected — invalid signature from %s',
      req.url,
      fromDomain
    );
    jsonResponse(res, 401, { error: 'Invalid signature' });
    return null;
  }

  logger.debug(
    '[federation] > %s from %s (instanceId=%d)',
    req.url,
    fromDomain,
    instance.id
  );

  return {
    instance: {
      id: instance.id,
      publicKey: instance.publicKey,
      domain: instance.domain
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
  MAX_PEER_SERVER_NAME_LENGTH,
  MAX_PEER_SKDM_RECIPIENTS,
  PEER_BANNER_COLOR_RE,
  PEER_DOMAIN_RE,
  parseBody,
  jsonResponse,
  authorizeFederationRequest,
  isPeerDomain,
  isPeerPublicId,
  isPeerSenderKeyId,
  peerString,
  peerStringArray
};
