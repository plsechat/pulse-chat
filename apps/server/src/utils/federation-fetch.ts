/**
 * Wraps fetch with `redirect: 'manual'` and a per-peer outbound rate
 * limit. Federation endpoints (peer instances, federated avatar/file
 * downloads) must respond directly; redirects are an SSRF pivot
 * vector even after the original URL has been validated by
 * `validateFederationUrl` — the redirect target is never re-validated
 * by the runtime.
 *
 * Rate limit (Phase 4 / F6): token bucket keyed by URL host. Stops a
 * runaway loop, hostile-peer retry storm, or compromised handler
 * from hammering a single remote. Defaults: 60 burst, refilled at
 * 60/minute (1/sec sustained). Self-prunes long-idle buckets to
 * avoid unbounded growth.
 *
 * Treats 3xx and `status === 0` (opaque redirect) as errors.
 *
 * Does NOT pin DNS — DNS rebinding / TOCTOU between validation and
 * connect is a separate Phase 4 hardening item (F2). For now this
 * only closes redirects + abuse rate.
 */

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
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`federationFetch: invalid url ${url}`);
  }

  if (!_tryConsumeFederationToken(host)) {
    throw new FederationRateLimitError(host);
  }

  const response = await fetch(url, {
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
