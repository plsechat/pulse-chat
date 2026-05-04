/**
 * Hardened wrapper around fetch for federation endpoints. Layers:
 *
 *   1. F4 SSRF re-validation (was Phase 4 / F2): every call routes
 *      through `validateFederationUrl` again, so even if the caller
 *      forgot — or if minutes have passed since they validated —
 *      we re-resolve DNS at the fetch boundary and reject any
 *      hostname that now points to a private IP. This collapses
 *      the long-window TOCTOU. A residual short window between
 *      this DNS lookup and the actual TCP connect still exists —
 *      fully closing it requires a custom undici dispatcher with
 *      IP pinning, which is environment-specific (Bun's native
 *      fetch doesn't expose the same hooks as undici on Node).
 *      Tracked as a follow-up.
 *
 *   2. `redirect: 'manual'`: federation endpoints must respond
 *      directly; redirects are an SSRF pivot vector even after a
 *      validated URL because the redirect target is never
 *      re-validated by the runtime. 3xx and opaque (status === 0)
 *      responses both throw.
 *
 *   3. F6 outbound per-peer rate limit: token bucket keyed by URL
 *      host. Stops a runaway loop, hostile-peer retry storm, or
 *      compromised handler from hammering a single remote. 60
 *      burst, refilled at 60/minute (1/sec sustained). Self-prunes
 *      long-idle peers when the map crosses 1024 entries.
 */

import { validateFederationUrl } from './validate-url';

const RATE_LIMIT_CAPACITY = 60;
const RATE_LIMIT_REFILL_PER_MS = RATE_LIMIT_CAPACITY / 60_000;
const BUCKET_IDLE_MS = 60 * 60 * 1000;
const BUCKET_PRUNE_THRESHOLD = 1024;

type RateLimitBucket = { tokens: number; lastRefillAt: number };
const rateLimitBuckets = new Map<string, RateLimitBucket>();

export function _resetFederationRateLimit(): void {
  rateLimitBuckets.clear();
}

export function _tryConsumeFederationToken(host: string): boolean {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(host);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefillAt: now };
    rateLimitBuckets.set(host, bucket);
  } else {
    const elapsed = now - bucket.lastRefillAt;
    bucket.tokens = Math.min(
      RATE_LIMIT_CAPACITY,
      bucket.tokens + elapsed * RATE_LIMIT_REFILL_PER_MS
    );
    bucket.lastRefillAt = now;
  }

  // Opportunistic cleanup of long-idle peers. Bounded — only walks
  // the map when it crosses the prune threshold, so the steady-state
  // hot path is O(1).
  if (rateLimitBuckets.size > BUCKET_PRUNE_THRESHOLD) {
    for (const [k, b] of rateLimitBuckets) {
      if (now - b.lastRefillAt > BUCKET_IDLE_MS) {
        rateLimitBuckets.delete(k);
      }
    }
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export class FederationRateLimitError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`Outbound federation rate limit exceeded for ${host}`);
    this.name = 'FederationRateLimitError';
    this.host = host;
  }
}

export async function federationFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  // Re-validate at the fetch boundary so we catch:
  //   - Callers that forgot to validate up front
  //   - DNS rebinding between an earlier validate and now
  //   - Localhost / IP-literal slips through code paths that
  //     hand-build the URL (e.g. relayToInstance constructs
  //     `${protocol}://${instanceDomain}${path}` directly)
  // The validator also rejects non-HTTP(S) and unresolvable hosts.
  const validated = await validateFederationUrl(url);
  const host = validated.host;

  if (!_tryConsumeFederationToken(host)) {
    throw new FederationRateLimitError(host);
  }

  const response = await fetch(validated.href, {
    ...init,
    redirect: 'manual'
  });

  if (response.status === 0) {
    // Opaque redirect (cross-origin or any redirect with redirect:'manual').
    throw new Error(`Refusing opaque redirect from ${url}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Refusing redirect from ${url} (status ${response.status})`
    );
  }

  return response;
}
