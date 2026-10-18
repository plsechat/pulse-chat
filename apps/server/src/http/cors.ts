import { eq } from 'drizzle-orm';
import { db } from '../db';
import { federationInstances } from '../db/schema';
import { IS_DEVELOPMENT } from '../utils/env';

let cachedOrigins: Set<string> | null = null;
let cacheTime = 0;
const CACHE_TTL = 60_000; // 1 minute

/**
 * The domains of every ACTIVE federation peer, as stored (`host` or
 * `host:port`). One cached Set per refresh: the same object is handed
 * back until the TTL lapses or `invalidateCorsCache` runs, so callers
 * that derive something from the list (the CSP string) can memoize on
 * its identity instead of re-walking it per request.
 */
export async function getActiveFederationDomains(): Promise<Set<string>> {
  const now = Date.now();
  if (!cachedOrigins || now - cacheTime > CACHE_TTL) {
    try {
      const instances = await db
        .select({ domain: federationInstances.domain })
        .from(federationInstances)
        .where(eq(federationInstances.status, 'active'));

      cachedOrigins = new Set(instances.map((i) => i.domain));
    } catch {
      // DB might not be ready during startup
      cachedOrigins = new Set();
    }
    cacheTime = now;
  }
  return cachedOrigins;
}

/**
 * Check if an Origin header value is allowed for CORS.
 * Allows: same-host requests, active federated instance domains, dev localhost.
 */
export async function isAllowedOrigin(
  origin: string,
  host: string | undefined
): Promise<boolean> {
  try {
    const originUrl = new URL(origin);
    const originHost = originUrl.host;

    // Same origin — always allowed
    if (host && originHost === host) return true;

    // Development — allow all for local testing
    if (IS_DEVELOPMENT) return true;

    // Check against active federated instance domains (cached)
    const domains = await getActiveFederationDomains();
    return domains.has(originHost);
  } catch {
    return false;
  }
}

/** Call when federation instance list changes to bust the CORS cache. */
export function invalidateCorsCache(): void {
  cachedOrigins = null;
  cacheTime = 0;
}
