/**
 * Per-publicId rate limit for the inbound federation pre-key bundle
 * fetch route. Distinct from the per-host outbound rate limit in
 * `federation-fetch.ts`:
 *
 * - That bucket protects US from runaway loops calling a single peer.
 * - This bucket protects each LOCAL user from a peer enumerating
 *   bundles to exhaust their one-time pre-key pool.
 *
 * Each successful bundle fetch claims one OTPK (single-use, by Signal
 * spec). A pool exhaustion forces the user's client to replenish on
 * next sign-in or interactive use, but the meantime breaks new
 * cross-instance session establishment for them. Rate-limiting per
 * publicId stops a single hostile peer from doing that quickly.
 *
 * Token bucket: 10 burst, refilled at 10/min (one per 6 seconds
 * sustained). Real legitimate usage is "establish session once per
 * cross-instance peer, then re-use the X3DH chain" — a single user
 * should never legitimately need more than a few bundles per minute
 * even at the height of cross-instance DMing. Self-prunes long-idle
 * publicIds when the map crosses 1024 entries.
 */

const BUNDLE_RATE_LIMIT_CAPACITY = 10;
const BUNDLE_RATE_LIMIT_REFILL_PER_MS = BUNDLE_RATE_LIMIT_CAPACITY / 60_000;
const BUNDLE_BUCKET_IDLE_MS = 60 * 60 * 1000;
const BUNDLE_BUCKET_PRUNE_THRESHOLD = 1024;

type BundleRateLimitBucket = { tokens: number; lastRefillAt: number };
const bundleRateLimitBuckets = new Map<string, BundleRateLimitBucket>();

export function _resetBundleFetchRateLimit(): void {
  bundleRateLimitBuckets.clear();
}

export function _tryConsumeBundleFetchToken(publicId: string): boolean {
  const now = Date.now();
  let bucket = bundleRateLimitBuckets.get(publicId);
  if (!bucket) {
    bucket = {
      tokens: BUNDLE_RATE_LIMIT_CAPACITY,
      lastRefillAt: now
    };
    bundleRateLimitBuckets.set(publicId, bucket);
  } else {
    const elapsed = now - bucket.lastRefillAt;
    bucket.tokens = Math.min(
      BUNDLE_RATE_LIMIT_CAPACITY,
      bucket.tokens + elapsed * BUNDLE_RATE_LIMIT_REFILL_PER_MS
    );
    bucket.lastRefillAt = now;
  }

  // Opportunistic cleanup of long-idle publicIds. Bounded — only walks
  // the map when it crosses the prune threshold.
  if (bundleRateLimitBuckets.size > BUNDLE_BUCKET_PRUNE_THRESHOLD) {
    for (const [k, b] of bundleRateLimitBuckets) {
      if (now - b.lastRefillAt > BUNDLE_BUCKET_IDLE_MS) {
        bundleRateLimitBuckets.delete(k);
      }
    }
  }

  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}
