import type { PluginContext } from '@pulse/plugin-sdk';

/**
 * REST access to the remote service through `ctx.fetch`.
 *
 * Every request goes to ONE fixed origin under the versioned prefix,
 * built from a relative path this module composes — never a URL that
 * came out of a payload — so a hostile message cannot steer the bot at
 * another address (`ctx.fetch` refuses private targets anyway; this
 * keeps the public ones to the one we mean).
 *
 * Rate limits are honoured the way the API documents them: each
 * answer's `X-RateLimit-Remaining` / `Reset-After` feeds a per-route
 * bucket the next request on that route waits on, a 429 sleeps for the
 * `retry_after` it names (bounded) and retries, a 5xx backs off and
 * retries a few times. On top of that the server's own outbound client
 * allows 60 requests a minute per host: the bridge keeps a mirror of
 * that budget (a little under it) so a burst queues here instead of
 * failing there, and treats the server's refusal as one more thing to
 * wait out. Requests are sent one at a time, in order, because an edit
 * must never overtake the create it depends on.
 */

export const API_ORIGIN = 'https://discord.com';
export const API_PREFIX = '/api/v10';
const USER_AGENT = 'PULSE bridge (https://github.com/plsechat/pulse)';

/** The server-side per-host budget is 60/min; stay a step under it. */
const HOST_BUDGET_CAPACITY = 55;
const HOST_BUDGET_REFILL_PER_MS = 60 / 60_000;
const MAX_RETRY_WAIT_MS = 60_000;
const MAX_ATTEMPTS = 6;
const SERVER_ERROR_BACKOFF_MS = 1_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** A message page with embeds is well under this. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export class RestError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, message?: string) {
    super(message ?? `API answered ${status} for ${path}`);
    this.name = 'RestError';
    this.status = status;
    this.path = path;
  }
}

export type TRestDeps = {
  fetch: PluginContext['fetch'];
  token: () => string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

type TRequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Webhook routes authenticate by their token, not the bot's. */
  auth?: boolean;
  /** Audit-log reason header, when the API records one. */
  reason?: string;
};

type TBucket = { remaining: number; resetAt: number };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The URL the client will dial, or a throw: only the API origin, only
 * under the versioned prefix, no path with its own authority.
 */
export const assertApiUrl = (path: string): string => {
  if (!path.startsWith('/') || path.startsWith('//') || /[\s\\]/.test(path)) {
    throw new RestError(0, path, 'Refusing a path outside the API');
  }

  const url = new URL(`${API_PREFIX}${path}`, API_ORIGIN);

  if (
    url.origin !== API_ORIGIN ||
    !url.pathname.startsWith(`${API_PREFIX}/`) ||
    url.pathname.includes('..')
  ) {
    throw new RestError(0, path, 'Refusing a path outside the API');
  }

  return url.href;
};

/** `/channels/123/messages/456` → `/channels/123/messages/:id`: ids after the first share a bucket. */
export const routeKey = (path: string): string => {
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

const retryAfterMs = (status429Body: unknown, headers: Record<string, string>): number => {
  const body = status429Body as { retry_after?: unknown } | null;
  const fromBody =
    body && typeof body.retry_after === 'number' ? body.retry_after * 1000 : NaN;
  const fromHeader = Number.parseFloat(headers['retry-after'] ?? '') * 1000;
  const wait = Number.isFinite(fromBody) ? fromBody : fromHeader;

  return Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_RETRY_WAIT_MS) : 1_000;
};

const isHostBudgetRefusal = (error: unknown): boolean =>
  error instanceof Error && /rate limit exceeded/i.test(error.message);

export class RestClient {
  private readonly fetch: PluginContext['fetch'];
  private readonly token: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly buckets = new Map<string, TBucket>();
  private hostTokens = HOST_BUDGET_CAPACITY;
  private hostRefilledAt: number;
  private queue: Promise<unknown> = Promise.resolve();
  /** Requests actually sent; the status card reads it. */
  requestCount = 0;

  constructor(deps: TRestDeps) {
    this.fetch = deps.fetch;
    this.token = deps.token;
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
    this.hostRefilledAt = this.now();
  }

  get<T>(path: string, options: Omit<TRequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: TRequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  patch<T>(path: string, options: TRequestOptions = {}): Promise<T> {
    return this.request<T>('PATCH', path, options);
  }

  put<T>(path: string, options: TRequestOptions = {}): Promise<T> {
    return this.request<T>('PUT', path, options);
  }

  delete<T>(path: string, options: TRequestOptions = {}): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }

  /** One request at a time, in call order. */
  request<T>(method: string, path: string, options: TRequestOptions = {}): Promise<T> {
    const run = this.queue.then(() => this.send<T>(method, path, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async waitForHostBudget() {
    const now = this.now();
    const elapsed = Math.max(0, now - this.hostRefilledAt);
    this.hostTokens = Math.min(
      HOST_BUDGET_CAPACITY,
      this.hostTokens + elapsed * HOST_BUDGET_REFILL_PER_MS
    );
    this.hostRefilledAt = now;

    if (this.hostTokens < 1) {
      const wait = Math.ceil((1 - this.hostTokens) / HOST_BUDGET_REFILL_PER_MS);
      await this.sleep(wait);
      this.hostTokens = 1;
      this.hostRefilledAt = this.now();
    }

    this.hostTokens -= 1;
  }

  private async waitForRouteBudget(key: string) {
    const bucket = this.buckets.get(key);
    const now = this.now();

    if (bucket && bucket.remaining <= 0 && bucket.resetAt > now) {
      await this.sleep(Math.min(bucket.resetAt - now, MAX_RETRY_WAIT_MS));
    }
  }

  private recordBudget(key: string, headers: Record<string, string>) {
    const remaining = Number.parseInt(headers['x-ratelimit-remaining'] ?? '', 10);
    const resetAfter = Number.parseFloat(headers['x-ratelimit-reset-after'] ?? '');

    if (!Number.isFinite(remaining) || !Number.isFinite(resetAfter)) return;

    this.buckets.set(key, { remaining, resetAt: this.now() + resetAfter * 1000 });
  }

  private async send<T>(method: string, path: string, options: TRequestOptions): Promise<T> {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) params.set(name, String(value));
    }
    const search = params.size > 0 ? `?${params.toString()}` : '';
    const url = assertApiUrl(`${path}${search}`);
    const key = `${method} ${routeKey(path)}`;

    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/json'
    };

    if (options.auth !== false) {
      const token = this.token();
      if (!token) throw new RestError(0, path, 'No bot token configured');
      headers.Authorization = `Bot ${token}`;
    }

    if (options.reason) headers['X-Audit-Log-Reason'] = options.reason.slice(0, 256);

    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.waitForRouteBudget(key);
      await this.waitForHostBudget();
      this.requestCount++;

      let response: Awaited<ReturnType<PluginContext['fetch']>>;

      try {
        response = await this.fetch(url, {
          method,
          headers,
          body,
          timeoutMs: REQUEST_TIMEOUT_MS,
          maxBytes: MAX_BODY_BYTES
        });
      } catch (error) {
        // The server's outbound budget for the host ran dry: our mirror
        // drifted (another plugin shares the host). Wait a refill step.
        if (isHostBudgetRefusal(error) && attempt < MAX_ATTEMPTS) {
          await this.sleep(1_000 * attempt);
          continue;
        }
        throw new RestError(
          0,
          path,
          `Request failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }

      this.recordBudget(key, response.headers);

      const contentType = response.headers['content-type'] ?? '';
      let parsed: unknown = null;

      if (response.status !== 204 && /json/i.test(contentType)) {
        try {
          parsed = await response.json();
        } catch {
          parsed = null;
        }
      }

      if (response.status === 429) {
        if (attempt === MAX_ATTEMPTS) {
          throw new RestError(429, path, 'Rate limited for too long');
        }
        await this.sleep(retryAfterMs(parsed, response.headers));
        continue;
      }

      if (response.status >= 500) {
        if (attempt === MAX_ATTEMPTS) throw new RestError(response.status, path);
        await this.sleep(SERVER_ERROR_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      if (response.status >= 400) {
        const detail = parsed as { message?: unknown; code?: unknown } | null;
        const message =
          detail && typeof detail.message === 'string' ? `: ${detail.message}` : '';
        throw new RestError(
          response.status,
          path,
          `API answered ${response.status} for ${path}${message}`
        );
      }

      return parsed as T;
    }

    throw new RestError(0, path, 'Gave up');
  }
}
