import type { TIpInfo } from '@pulse/shared';

const IP_CACHE_TTL = 1000 * 60 * 60; // 1 hour
const SWEEP_INTERVAL = 1000 * 60 * 5; // 5 minutes

/**
 * Hard ceiling on cached addresses. Keys are validated IP literals, so
 * only a distinct-source flood can grow this; past the cap the OLDEST
 * entry goes (Map keeps insertion order).
 */
const MAX_ENTRIES = 10_000;

/**
 * Geo lookups keyed by client address. A `Map` (not a `Record`) so a
 * key like `__proto__` is just a key, and one periodic sweep instead of
 * a timer per entry — the per-entry timers kept the event loop alive
 * and grew with every distinct address.
 */
class IpInfoCache {
  private cache = new Map<string, { data: TIpInfo; expiresAt: number }>();

  get(ip: string): TIpInfo | undefined {
    const entry = this.cache.get(ip);
    if (!entry) return undefined;

    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(ip);
      return undefined;
    }

    return entry.data;
  }

  set(ip: string, data: TIpInfo): void {
    if (!this.cache.has(ip) && this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }

    this.cache.set(ip, { data, expiresAt: Date.now() + IP_CACHE_TTL });
  }

  sweep(now = Date.now()): void {
    for (const [ip, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(ip);
    }
  }

  get size(): number {
    return this.cache.size;
  }

  /** Test hook: drop every entry. */
  clear(): void {
    this.cache.clear();
  }
}

const ipCache = new IpInfoCache();

const sweepInterval = setInterval(() => ipCache.sweep(), SWEEP_INTERVAL);
sweepInterval.unref();

export { ipCache };
