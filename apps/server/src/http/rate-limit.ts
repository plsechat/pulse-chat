import http from 'http';
import {
  consumeRateLimit,
  rateLimitKey,
  type RateLimitConfig
} from './rate-limit-core';

/**
 * Fixed-window per-client limiter for the HTTP routes. Buckets are
 * keyed on `ip:pathname` (query string ignored) via `rate-limit-core`;
 * pass `key` to bucket on something else (a webhook id, a route prefix
 * whose path tail varies per resource).
 *
 * Returns false after writing the 429 so the caller just `return`s.
 *
 * The export surface of THIS module is fixed by the test preload
 * (`__tests__/mock-modules.ts` replaces it so suites never 429): the
 * limit configs and the bucket store live in `rate-limit-core`, which
 * is what new code should import.
 */
function checkRateLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RateLimitConfig,
  key: string = rateLimitKey(req)
): boolean {
  const result = consumeRateLimit(key, config);

  if (!result.allowed) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(result.retryAfterSec)
    });
    res.end(
      JSON.stringify({
        error: 'Too many requests, please try again later'
      })
    );
    return false;
  }

  return true;
}

export { checkRateLimit };
