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
  parseBody,
  jsonResponse,
  authorizeFederationRequest
};
