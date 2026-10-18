import { getClientIp, type TRequestLike } from '../helpers/get-ws-info';

/**
 * Fixed-window counters behind `http/rate-limit.ts`. Kept apart from
 * the HTTP wrapper so the key/bucket behaviour has a real unit test:
 * the test preload replaces `http/rate-limit` wholesale (every suite
 * would otherwise exhaust the auth budget), and a `mock.module`
 * replacement cannot be bypassed from inside the same process.
 */
type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
};

type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSec: number };

type TRateLimitRequest = TRequestLike & { url?: string };

/**
 * Hard ceiling on tracked buckets. Keys are `ip:pathname`, so a single
 * attacker can at most mint one bucket per distinct source address;
 * past the cap the OLDEST bucket is evicted (Map keeps insertion order)
 * so memory stays flat under a spoofed-address flood.
 */
const MAX_BUCKETS = 50_000;

const buckets = new Map<string, { count: number; resetAt: number }>();

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) {
      buckets.delete(key);
    }
  }
}, 60_000);

cleanupInterval.unref();

/**
 * Path-only key: the query string is dropped so `?x=<random>` cannot
 * mint a fresh bucket per request, and `/auth/oidc/callback?code=…`
 * shares one budget per client like every other route.
 */
const rateLimitKey = (req: TRateLimitRequest): string => {
  const url = req.url ?? '/';
  const queryAt = url.indexOf('?');
  const pathname = queryAt === -1 ? url : url.slice(0, queryAt);

  return `${getClientIp(req)}:${pathname}`;
};

const consumeRateLimit = (key: string, config: RateLimitConfig): RateLimitResult => {
  const now = Date.now();

  let bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next();
      if (!oldest.done) buckets.delete(oldest.value);
    }
    bucket = { count: 0, resetAt: now + config.windowMs };
    buckets.set(key, bucket);
  }

  bucket.count++;

  if (bucket.count > config.maxRequests) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))
    };
  }

  return { allowed: true };
};

/** Test hook: drop every bucket. */
const _resetAll = (): void => {
  buckets.clear();
};

/** Test hook: number of tracked buckets. */
const _bucketCount = (): number => buckets.size;

// Optional env overrides. Defaults are the shipped behavior; the knobs
// exist for operators behind shared NATs (many users, one IP) and for
// test rigs (the E2E suite logs in per-test and would exhaust the
// default budget immediately).
const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const authRateLimit: RateLimitConfig = {
  windowMs: envInt('AUTH_RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  maxRequests: envInt('AUTH_RATE_LIMIT_MAX', 10)
};

const federationRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60
};

/** Unauthenticated federation reads (`/federation/info`) and the IP brake on `/federation/servers`. */
const federationReadRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60
};

/**
 * Per VERIFIED peer (`peer:<class>:<domain>`, see
 * http/federation-helpers.ts): the budget one pairing gets across every
 * signed route, independent of the address it arrives from. Sized above
 * the per-IP brake so a peer on its own address never hits it before the
 * IP limiter does, but low enough that one peer cannot keep the loop busy.
 */
const federationPeerRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 300
};

/** `/federation/dm-relay` only — the route a peer's users can drive at will. */
const federationPeerDmRelayRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 120
};

const uploadRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 30
};

/**
 * `/public/*` serves every avatar, emoji and attachment a chat view
 * renders, so the per-IP budget is generous; it exists to bound the
 * DB round-trips a scripted flood can force, not to shape real use.
 */
const publicRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 600
};

/** Per `ip:/webhooks/<id>` — bounds token guessing and floods per source. */
const webhookRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 30
};

/** Per webhook id across all sources — caps what one integration can inject. */
const webhookIdRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60
};

/**
 * Per `ip:/plugins/<id>` — a plugin endpoint is an integration hook
 * (a chat bridge receiving upstream events), busier than a webhook but
 * still one service per source address.
 */
const pluginHttpRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 120
};

/** Per plugin id across all sources — the budget one plugin's ingress gets. */
const pluginHttpIdRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 600
};

export {
  _bucketCount,
  _resetAll,
  authRateLimit,
  consumeRateLimit,
  federationPeerDmRelayRateLimit,
  federationPeerRateLimit,
  federationRateLimit,
  federationReadRateLimit,
  MAX_BUCKETS,
  pluginHttpIdRateLimit,
  pluginHttpRateLimit,
  publicRateLimit,
  rateLimitKey,
  uploadRateLimit,
  webhookIdRateLimit,
  webhookRateLimit
};
export type { RateLimitConfig, RateLimitResult, TRateLimitRequest };
