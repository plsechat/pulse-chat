import http from 'http';

type RateLimitConfig = {
  windowMs: number;
  maxRequests: number;
};

const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

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

function checkRateLimit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: RateLimitConfig
): boolean {
  // Only trust proxy headers when explicitly configured (matches get-ws-info.ts)
  const proxyIp = TRUST_PROXY
    ? ((req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
       (req.headers['x-real-ip'] as string))
    : undefined;

  const ip = proxyIp || req.socket.remoteAddress || 'unknown';

  const key = `${ip}:${req.url}`;
  const now = Date.now();

  let bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + config.windowMs };
    buckets.set(key, bucket);
  }

  bucket.count++;

  if (bucket.count > config.maxRequests) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfter)
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

const authRateLimit: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  maxRequests: 10
};

const federationRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 60
};

const uploadRateLimit: RateLimitConfig = {
  windowMs: 60 * 1000,
  maxRequests: 30
};

export { checkRateLimit, authRateLimit, federationRateLimit, uploadRateLimit };
