/**
 * Hardened wrapper around fetch for federation endpoints and other
 * user-controlled URLs (link previews). Layers:
 *
 *   1. SSRF validation with DNS pinning: every call routes through
 *      `resolveFederationUrl`, which rejects private/internal targets
 *      (allowlist aside), fails closed on unresolvable hosts and hands
 *      back the address it validated. The connection is then opened to
 *      THAT address, with the original hostname carried as the `Host`
 *      header and, for https, as the TLS server name + the name the
 *      certificate is checked against. A resolver that answers public
 *      during validation and private at connect time (DNS rebinding)
 *      never gets a second lookup to exploit.
 *
 *   2. `redirect: 'manual'`: federation endpoints must respond
 *      directly; redirects are an SSRF pivot vector even after a
 *      validated URL because the redirect target is never
 *      re-validated by the runtime. 3xx and opaque (status === 0)
 *      responses both throw.
 *
 *   3. Outbound per-peer rate limit: token bucket keyed by URL
 *      host. Stops a runaway loop, hostile-peer retry storm, or
 *      compromised handler from hammering a single remote. 60
 *      burst, refilled at 60/minute (1/sec sustained). Self-prunes
 *      long-idle peers when the map crosses 1024 entries.
 *
 *   4. Bounded body: `.json()` / `.text()` on the returned response read
 *      through `readBodyWithCap` (default 1 MB), so a peer that answers a
 *      10-byte ack request with gigabytes is cut off before anything is
 *      buffered or parsed. Callers that stream the body themselves
 *      (`fetchBoundedImage`) read `.body` directly and keep their own cap.
 */

import tls from 'node:tls';
import { readBodyWithCap } from './outbound-fetch';
import { resolveFederationUrl } from './validate-url';

const RATE_LIMIT_CAPACITY = 60;
const RATE_LIMIT_REFILL_PER_MS = RATE_LIMIT_CAPACITY / 60_000;
const BUCKET_IDLE_MS = 60 * 60 * 1000;
const BUCKET_PRUNE_THRESHOLD = 1024;

/** Largest peer response body `.json()`/`.text()` will buffer. */
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

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

export interface FederationFetchInit extends Omit<RequestInit, 'redirect'> {
  /** Cap for `.json()` / `.text()`; the raw `.body` stream is uncapped. */
  maxBytes?: number;
}

/**
 * What `federationFetch` hands back: the status/header surface of the
 * runtime Response plus capped readers. `.body` is the live stream for
 * callers that apply their own streaming limit.
 */
export interface FederationResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  body: ReadableStream<Uint8Array> | null;
  /** The body bytes, read once through the cap and memoised. */
  bytes: () => Promise<Uint8Array>;
  text: () => Promise<string>;
  json: <T = unknown>() => Promise<T>;
}

function wrapResponse(response: Response, maxBytes: number): FederationResponse {
  let bytesPromise: Promise<Uint8Array> | null = null;
  const bytes = () => {
    if (!bytesPromise) bytesPromise = readBodyWithCap(response, maxBytes);
    return bytesPromise;
  };
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    url: response.url,
    body: response.body,
    bytes,
    text: async () => new TextDecoder().decode(await bytes()),
    json: async <T = unknown>() =>
      JSON.parse(new TextDecoder().decode(await bytes())) as T
  };
}

/** Merge caller headers (any HeadersInit shape) with the pinned Host. */
function headersWithHost(
  init: RequestInit['headers'],
  host: string
): Headers {
  const headers = new Headers(init);
  headers.set('Host', host);
  return headers;
}

export async function federationFetch(
  url: string,
  init: FederationFetchInit = {}
): Promise<FederationResponse> {
  const { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, ...requestInit } = init;

  // Validate at the fetch boundary so we catch:
  //   - Callers that forgot to validate up front
  //   - DNS rebinding between an earlier validate and now
  //   - Localhost / IP-literal slips through code paths that
  //     hand-build the URL (e.g. relayToInstance constructs
  //     `${protocol}://${instanceDomain}${path}` directly)
  // The validator also rejects non-HTTP(S) and unresolvable hosts.
  const { url: validated, pinnedIp, pinnedFamily } =
    await resolveFederationUrl(url);
  const host = validated.host;
  const hostname = validated.hostname.replace(/^\[|\]$/g, '');

  if (!_tryConsumeFederationToken(host)) {
    throw new FederationRateLimitError(host);
  }

  // Dial the address that was validated; the name travels in Host + SNI.
  // Bun routes by the URL host while presenting the headers and TLS
  // options given here, so the peer sees the request it expects.
  const pinned = new URL(validated.href);
  pinned.hostname = pinnedFamily === 6 ? `[${pinnedIp}]` : pinnedIp;

  const fetchInit: BunFetchRequestInit = {
    ...requestInit,
    headers: headersWithHost(requestInit.headers, host),
    redirect: 'manual'
  };
  if (validated.protocol === 'https:') {
    fetchInit.tls = {
      serverName: hostname,
      checkServerIdentity: (_host, cert) =>
        tls.checkServerIdentity(hostname, cert)
    };
  }

  const response = await fetch(pinned.href, fetchInit);

  if (response.status === 0) {
    // Opaque redirect (cross-origin or any redirect with redirect:'manual').
    throw new Error(`Refusing opaque redirect from ${url}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Refusing redirect from ${url} (status ${response.status})`
    );
  }

  return wrapResponse(response, maxBytes);
}
