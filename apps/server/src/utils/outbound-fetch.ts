/**
 * Hardened wrapper around `fetch` for outbound HTTP to trusted upstream
 * services (ipify, ipinfo, icanhazip, etc.) — i.e. fixed hostnames known
 * at build time. For user-controlled URLs (federation peers, link
 * previews) use `federationFetch` after validating with `validateUrl`.
 *
 * Adds:
 *  - `redirect: 'manual'` so a redirect from a trusted upstream to a
 *    private/internal address can't pivot SSRF
 *  - request timeout (default 5s)
 *  - response-body byte cap (default 256 KB) read via the streaming
 *    reader so we never buffer arbitrary upstream payloads
 *
 * Treats 3xx, opaque-redirect (`status === 0`), and over-cap bodies as
 * errors so callers don't accidentally consume a redirected/oversize
 * response.
 */
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 256 * 1024;

interface OutboundFetchOptions extends Omit<RequestInit, 'redirect' | 'signal'> {
  timeoutMs?: number;
  maxBytes?: number;
}

interface OutboundResponse {
  status: number;
  headers: Headers;
  text: () => Promise<string>;
  json: <T>() => Promise<T>;
}

async function readBodyWithCap(
  response: Response,
  maxBytes: number
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();

  let total = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Response body exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

export async function outboundFetch(
  url: string,
  options: OutboundFetchOptions = {}
): Promise<OutboundResponse> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    ...init
  } = options;

  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (response.status === 0) {
    throw new Error(`Refusing opaque redirect from ${url}`);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error(
      `Refusing redirect from ${url} (status ${response.status})`
    );
  }

  // Read once with the byte cap; expose .text/.json over the captured
  // bytes so callers can use either without re-reading the stream.
  const bytes = await readBodyWithCap(response, maxBytes);
  const decoded = new TextDecoder().decode(bytes);

  return {
    status: response.status,
    headers: response.headers,
    text: async () => decoded,
    json: async <T>() => JSON.parse(decoded) as T
  };
}
