import { GIF_PICKER_MEDIA_HOSTS } from '@pulse/shared';
import { outboundFetch, readBodyWithCap } from '../../utils/outbound-fetch';

/**
 * Read-only client for the Discord bot API, used by the community import.
 *
 * Every request goes to ONE fixed origin (`discord.com`, API v10) built
 * from a relative path the caller supplies — the client never dials a
 * host that came from the outside, so a hostile guild payload cannot
 * steer the import at an internal address. Asset downloads (icons,
 * emoji, attachments) are a separate call with its own CDN allowlist.
 *
 * Rate limits are honoured the way the API documents them: the
 * `X-RateLimit-*` headers of every answer feed a per-route bucket the
 * next request waits on, a 429 sleeps for the `retry_after` the body
 * names (bounded) and is retried, a 5xx backs off and is retried a few
 * times. The transport, clock and sleep are injectable so the tests
 * replay recorded fixtures without a network and without waiting.
 */

const API_ORIGIN = 'https://discord.com';
const API_PREFIX = '/api/v10';
/**
 * The service's own CDN and proxy, plus the GIF pickers' file hosts: a
 * picker GIF arrives as a `gifv` embed whose file lives there, and it
 * is re-hosted like an attachment. Nothing else is ever fetched.
 */
const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net', ...GIF_PICKER_MEDIA_HOSTS]);

/** One shared pace for the whole process: a comfortable margin under the global budget. */
const MIN_REQUEST_INTERVAL_MS = 25;
/** A 429 may ask for minutes; wait at most this long before giving up on the attempt. */
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_ATTEMPTS = 6;
const SERVER_ERROR_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Largest API body we buffer: a 100-message page with embeds is well under this. */
const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

type TDiscordTransportResponse = {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: unknown;
};

type TDiscordTransport = (
  url: string,
  headers: Record<string, string>
) => Promise<TDiscordTransportResponse>;

type TDiscordClientDeps = {
  transport?: TDiscordTransport;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

class DiscordApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message?: string) {
    super(message ?? `Discord API answered ${status} for ${path}`);
    this.name = 'DiscordApiError';
    this.status = status;
    this.path = path;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const defaultTransport: TDiscordTransport = async (url, headers) => {
  const response = await outboundFetch(url, {
    headers,
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: MAX_API_BODY_BYTES
  });
  const text = await response.text();
  let body: unknown = null;

  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  const flat: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    flat[key.toLowerCase()] = value;
  });

  return { status: response.status, headers: flat, body };
};

/**
 * The URL the client will dial, or a throw: only the API origin, only
 * under the versioned prefix. A path with its own scheme or authority
 * (`//evil.example/x`) is rejected before the URL is even built.
 */
const assertApiUrl = (path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path)) {
    throw new DiscordApiError(0, path, 'Refusing a path outside the API');
  }

  const url = new URL(`${API_PREFIX}${path}`, API_ORIGIN);

  if (
    url.origin !== API_ORIGIN ||
    !url.pathname.startsWith(`${API_PREFIX}/`) ||
    url.pathname.includes('..')
  ) {
    throw new DiscordApiError(0, path, 'Refusing a path outside the API');
  }

  return url.href;
};

/** `/channels/123/messages?after=4` → `/channels/123/messages`: ids after the first share a bucket. */
const routeKey = (path: string): string => {
  const [pathname] = path.split('?');
  let seenId = false;

  return pathname!
    .split('/')
    .map((segment) => {
      if (!/^\d{5,}$/.test(segment)) return segment;
      if (seenId) return ':id';
      seenId = true;
      return segment;
    })
    .join('/');
};

const retryAfterMs = (response: TDiscordTransportResponse): number => {
  const body = response.body as { retry_after?: unknown } | null;
  const fromBody =
    body && typeof body.retry_after === 'number' ? body.retry_after * 1000 : NaN;
  const fromHeader = Number.parseFloat(response.headers['retry-after'] ?? '') * 1000;
  const wait = Number.isFinite(fromBody) ? fromBody : fromHeader;

  return Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_RETRY_WAIT_MS) : 1_000;
};

type TBucket = { remaining: number; resetAt: number };

class DiscordApiClient {
  private readonly token: string;
  private readonly transport: TDiscordTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly buckets = new Map<string, TBucket>();
  private lastRequestAt = 0;
  /** Requests actually sent — the preview's duration estimate reads it. */
  requestCount = 0;

  constructor(token: string, deps: TDiscordClientDeps = {}) {
    this.token = token;
    this.transport = deps.transport ?? defaultTransport;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  private async waitForBudget(key: string) {
    const bucket = this.buckets.get(key);
    const now = this.now();

    if (bucket && bucket.remaining <= 0 && bucket.resetAt > now) {
      await this.sleep(Math.min(bucket.resetAt - now, MAX_RETRY_WAIT_MS));
    }

    const sinceLast = this.now() - this.lastRequestAt;
    if (sinceLast < MIN_REQUEST_INTERVAL_MS) {
      await this.sleep(MIN_REQUEST_INTERVAL_MS - sinceLast);
    }
  }

  private recordBudget(key: string, headers: Record<string, string>) {
    const remaining = Number.parseInt(headers['x-ratelimit-remaining'] ?? '', 10);
    const resetAfter = Number.parseFloat(headers['x-ratelimit-reset-after'] ?? '');

    if (!Number.isFinite(remaining) || !Number.isFinite(resetAfter)) return;

    this.buckets.set(key, {
      remaining,
      resetAt: this.now() + resetAfter * 1000
    });
  }

  async get<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(query)) {
      if (value !== undefined) params.set(name, String(value));
    }
    const search = params.size > 0 ? `?${params.toString()}` : '';
    const url = assertApiUrl(`${path}${search}`);
    const key = routeKey(path);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.waitForBudget(key);
      this.lastRequestAt = this.now();
      this.requestCount++;

      const response = await this.transport(url, {
        Authorization: `Bot ${this.token}`,
        'User-Agent': 'PULSE community import (https://github.com/plsechat/pulse)',
        Accept: 'application/json'
      });

      this.recordBudget(key, response.headers);

      if (response.status === 429) {
        if (attempt === MAX_ATTEMPTS) {
          throw new DiscordApiError(429, path, 'Rate limited for too long');
        }
        await this.sleep(retryAfterMs(response));
        continue;
      }

      if (response.status >= 500) {
        if (attempt === MAX_ATTEMPTS) {
          throw new DiscordApiError(response.status, path);
        }
        await this.sleep(SERVER_ERROR_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      if (response.status >= 400) {
        const body = response.body as { message?: unknown } | null;
        const detail =
          body && typeof body.message === 'string' ? `: ${body.message}` : '';
        throw new DiscordApiError(
          response.status,
          path,
          `Discord API answered ${response.status} for ${path}${detail}`
        );
      }

      return response.body as T;
    }

    throw new DiscordApiError(0, path, 'Gave up');
  }
}

/**
 * The only hosts an import downloads bytes from. Everything the API
 * hands us (icon hashes, attachment URLs) is turned into one of these
 * by the mapping layer; a URL elsewhere is refused here regardless.
 */
const assertCdnUrl = (url: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Not a valid asset URL');
  }

  if (parsed.protocol !== 'https:' || !CDN_HOSTS.has(parsed.hostname)) {
    throw new Error(`Refusing to download from ${parsed.hostname}`);
  }

  return parsed;
};

const ASSET_TIMEOUT_MS = 30_000;

/**
 * Download one CDN asset with the same hardening as `outboundFetch`
 * (fixed hosts, no redirects, timeout, body read through the streaming
 * cap) — but as raw bytes: `outboundFetch` decodes its body as text,
 * which would corrupt an image. The cap is the upload limit the caller
 * passes, so an oversize attachment costs at most that much memory.
 */
const downloadCdnAsset = async (url: string, maxBytes: number): Promise<Uint8Array> => {
  const parsed = assertCdnUrl(url);
  const response = await fetch(parsed.href, {
    redirect: 'manual',
    signal: AbortSignal.timeout(ASSET_TIMEOUT_MS)
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Refusing redirect from ${parsed.hostname}`);
  }

  if (response.status !== 200) {
    throw new Error(`Asset download answered ${response.status}`);
  }

  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Asset exceeds ${maxBytes} bytes`);
  }

  return readBodyWithCap(response, maxBytes);
};

export type { TDiscordClientDeps, TDiscordTransport, TDiscordTransportResponse };
export {
  assertApiUrl,
  assertCdnUrl,
  DiscordApiClient,
  DiscordApiError,
  downloadCdnAsset,
  routeKey
};
