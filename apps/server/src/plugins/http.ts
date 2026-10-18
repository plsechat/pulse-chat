import type {
  TPluginHttpHandler,
  TPluginHttpRequest,
  TPluginHttpResponse
} from '@pulse/plugin-sdk';
import { timingSafeEqual } from 'crypto';
import type http from 'http';
import { logger } from '../logger';
import { PluginActionError } from './errors';

/**
 * Plugin HTTP ingress: `GET`/`POST /plugins/<pluginId>/<path>`.
 *
 * A plugin registers handlers through `ctx.http.register`; the server
 * keeps them here, keyed by plugin, and drops them on unload. Every
 * request must carry the plugin's secret in `x-pulse-plugin-secret`
 * (minted on the first registration and persisted with the plugin's
 * settings, where the instance owner reads it), so an endpoint is
 * reachable by the one service the owner pasted the secret into and
 * nobody else — no plugin gets to opt out of that. The body is capped
 * at 1 MiB and the mount applies the shared per-IP and per-plugin
 * rate limits before the handler runs; a handler that throws answers
 * 500 and logs to the plugin's log, never to the caller.
 */

const PLUGIN_SECRET_HEADER = 'x-pulse-plugin-secret';
const PLUGIN_HTTP_BODY_LIMIT_BYTES = 1024 * 1024;
/** A handler that never answers must not hold the request open forever. */
const HANDLER_TIMEOUT_MS = 30_000;
/** Routes per plugin — an API surface, not a file server. */
const MAX_ROUTES_PER_PLUGIN = 32;
const MAX_ROUTE_PATH_LENGTH = 128;
const MAX_QUERY_ENTRIES = 64;
const MAX_QUERY_VALUE_LENGTH = 2048;
const MAX_RESPONSE_HEADERS = 32;
/** Plugin ids are directory names; `..`, separators and NUL are refused by the loader too. */
const PLUGIN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
/** Segments of letters, digits, `-`, `_`, `.`; no empty segment, no `..`. */
const ROUTE_SEGMENT_PATTERN = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,63}$/;
/** Response headers the handler may not set: the server owns framing and security. */
const FORBIDDEN_RESPONSE_HEADERS = new Set([
  'content-length',
  'transfer-encoding',
  'connection',
  'set-cookie',
  'content-security-policy',
  'strict-transport-security',
  'access-control-allow-origin'
]);

type TParsedPluginUrl = {
  pluginId: string;
  path: string;
  query: Record<string, string>;
};

/**
 * Canonical form of a registered path: leading/trailing slashes dropped,
 * every segment checked. Throws BAD_REQUEST so `ctx.http.register`
 * reports a bad path at registration, not at the first request.
 */
const normalizePluginRoutePath = (rawPath: string): string => {
  if (typeof rawPath !== 'string' || rawPath.length > MAX_ROUTE_PATH_LENGTH) {
    throw new PluginActionError(
      'BAD_REQUEST',
      `A route path is a string of at most ${MAX_ROUTE_PATH_LENGTH} characters`
    );
  }

  const segments = rawPath.split('/').filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    throw new PluginActionError('BAD_REQUEST', 'A route path needs at least one segment');
  }

  for (const segment of segments) {
    if (segment === '..' || !ROUTE_SEGMENT_PATTERN.test(segment)) {
      throw new PluginActionError(
        'BAD_REQUEST',
        `Invalid route path segment "${segment}": letters, digits, "-", "_" and "." only`
      );
    }
  }

  return segments.join('/');
};

/** `/plugins/<id>/<path>?q` → its parts, or undefined when it is not one of ours. */
const parsePluginHttpUrl = (rawUrl: string): TParsedPluginUrl | undefined => {
  // A fragment never reaches a server in practice; drop it first so it
  // can neither hide in the path nor ride along inside a query value.
  const hashAt = rawUrl.indexOf('#');
  const url = hashAt === -1 ? rawUrl : rawUrl.slice(0, hashAt);
  const queryAt = url.indexOf('?');
  const cleanPath = queryAt === -1 ? url : url.slice(0, queryAt);
  const match = cleanPath.match(/^\/plugins\/([^/]+)\/(.+)$/);

  if (!match) return undefined;

  const pluginId = match[1]!;

  if (!PLUGIN_ID_PATTERN.test(pluginId)) return undefined;

  let path: string;

  try {
    path = normalizePluginRoutePath(match[2]!);
  } catch {
    return undefined;
  }

  const query: Record<string, string> = {};

  if (queryAt !== -1) {
    const params = new URLSearchParams(url.slice(queryAt + 1));
    let count = 0;

    for (const [key, value] of params) {
      if (++count > MAX_QUERY_ENTRIES) break;
      if (key.length === 0 || key.length > 256) continue;
      query[key] = value.slice(0, MAX_QUERY_VALUE_LENGTH);
    }
  }

  return { pluginId, path, query };
};

class PluginHttpRegistry {
  private routes = new Map<string, Map<string, TPluginHttpHandler>>();

  /** Registers (or replaces) a handler; returns the canonical path. */
  public register = (
    pluginId: string,
    rawPath: string,
    handler: TPluginHttpHandler
  ): { path: string; replaced: boolean } => {
    const path = normalizePluginRoutePath(rawPath);

    if (typeof handler !== 'function') {
      throw new PluginActionError('BAD_REQUEST', 'A route handler must be a function');
    }

    let pluginRoutes = this.routes.get(pluginId);

    if (!pluginRoutes) {
      pluginRoutes = new Map();
      this.routes.set(pluginId, pluginRoutes);
    }

    const replaced = pluginRoutes.has(path);

    if (!replaced && pluginRoutes.size >= MAX_ROUTES_PER_PLUGIN) {
      throw new PluginActionError(
        'BAD_REQUEST',
        `A plugin may register at most ${MAX_ROUTES_PER_PLUGIN} routes`
      );
    }

    pluginRoutes.set(path, handler);

    return { path, replaced };
  };

  public get = (pluginId: string, path: string): TPluginHttpHandler | undefined =>
    this.routes.get(pluginId)?.get(path);

  public has = (pluginId: string): boolean => (this.routes.get(pluginId)?.size ?? 0) > 0;

  public routeCount = (pluginId: string): number => this.routes.get(pluginId)?.size ?? 0;

  public unregisterAll = (pluginId: string) => {
    this.routes.delete(pluginId);
  };
}

const pluginHttp = new PluginHttpRegistry();

/** Constant-time string equality; a length mismatch is still a full compare. */
const secretsMatch = (expected: string, presented: string): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);

  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }

  return timingSafeEqual(a, b);
};

const json = (res: http.ServerResponse, status: number, body: object) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

class BodyTooLargeError extends Error {}

/** Buffer the body up to the cap; past it the request is drained and refused. */
const readBody = (req: http.IncomingMessage, maxBytes: number): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    const cleanup = () => {
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.removeAllListeners('error');
    };

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;

      if (total > maxBytes) {
        cleanup();
        req.resume();
        reject(new BodyTooLargeError());
        return;
      }

      chunks.push(chunk);
    });
    req.on('end', () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      cleanup();
      reject(err);
    });
  });

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value.join(', ') : value;

type TPluginHttpDeps = {
  /** Only a loaded plugin's routes are live; a disabled one is a 404 like an unknown one. */
  isPluginLoaded: (pluginId: string) => boolean;
  /** The plugin's secret, or undefined when it never registered a route. */
  getPluginSecret: (pluginId: string) => Promise<string | undefined>;
  logPlugin: (pluginId: string, type: 'error' | 'debug', ...message: unknown[]) => void;
};

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Handler did not answer within ${ms} ms`)),
      ms
    );

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const sendHandlerResponse = (
  res: http.ServerResponse,
  response: TPluginHttpResponse
) => {
  const status =
    Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
      ? response.status
      : 500;

  const headers: Record<string, string> = {};
  let count = 0;

  for (const [name, value] of Object.entries(response.headers ?? {})) {
    const lower = name.toLowerCase();

    if (++count > MAX_RESPONSE_HEADERS) break;
    if (!/^[a-z0-9-]{1,128}$/.test(lower) || FORBIDDEN_RESPONSE_HEADERS.has(lower)) continue;
    if (typeof value !== 'string' || value.length > 8192) continue;

    headers[lower] = value;
  }

  if (response.body === undefined || response.body === null) {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  if (typeof response.body === 'string') {
    headers['content-type'] ??= 'text/plain; charset=utf-8';
    res.writeHead(status, headers);
    res.end(response.body);
    return;
  }

  headers['content-type'] ??= 'application/json';
  res.writeHead(status, headers);
  res.end(JSON.stringify(response.body));
};

const createPluginHttpRouteHandler =
  (deps: TPluginHttpDeps) =>
  async (req: http.IncomingMessage, res: http.ServerResponse, parsed: TParsedPluginUrl) => {
    const { pluginId, path, query } = parsed;
    const handler = deps.isPluginLoaded(pluginId) ? pluginHttp.get(pluginId, path) : undefined;

    // One answer for "no such plugin", "plugin disabled" and "no such
    // route" so the mount is not a plugin-inventory oracle.
    if (!handler) {
      req.resume();
      return json(res, 404, { error: 'Not found' });
    }

    const presented = headerValue(req.headers[PLUGIN_SECRET_HEADER]);
    const expected = await deps.getPluginSecret(pluginId);

    if (!presented || !expected || !secretsMatch(expected, presented)) {
      req.resume();
      return json(res, 401, { error: `Missing or invalid ${PLUGIN_SECRET_HEADER}` });
    }

    const method = req.method === 'POST' ? 'POST' : 'GET';
    let body: unknown = null;

    if (method === 'POST') {
      let raw: Buffer;

      try {
        raw = await readBody(req, PLUGIN_HTTP_BODY_LIMIT_BYTES);
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          return json(res, 413, {
            error: `Request body exceeded ${PLUGIN_HTTP_BODY_LIMIT_BYTES} bytes`
          });
        }

        return json(res, 400, { error: 'Could not read request body' });
      }

      const text = raw.toString('utf8');
      const contentType = headerValue(req.headers['content-type']) ?? '';

      if (/^application\/(.+\+)?json\b/i.test(contentType)) {
        try {
          body = text.length > 0 ? JSON.parse(text) : null;
        } catch {
          return json(res, 400, { error: 'Invalid JSON body' });
        }
      } else {
        body = text;
      }
    } else {
      req.resume();
    }

    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase();

      if (lower === PLUGIN_SECRET_HEADER) continue;

      const joined = headerValue(value);

      if (joined !== undefined) headers[lower] = joined;
    }

    const request: TPluginHttpRequest = { method, path, headers, query, body };

    try {
      const response = await withTimeout(
        Promise.resolve(handler(request)),
        HANDLER_TIMEOUT_MS
      );

      if (!response || typeof response !== 'object' || typeof response.status !== 'number') {
        throw new Error('Handler returned no { status } object');
      }

      sendHandlerResponse(res, response);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      deps.logPlugin(pluginId, 'error', `HTTP handler for /${path} failed: ${message}`);
      logger.error('[plugin-http] %s /%s failed: %s', pluginId, path, message);

      if (!res.headersSent) {
        json(res, 500, { error: 'Plugin handler failed' });
      }
    }
  };

export {
  createPluginHttpRouteHandler,
  MAX_ROUTES_PER_PLUGIN,
  normalizePluginRoutePath,
  parsePluginHttpUrl,
  PLUGIN_HTTP_BODY_LIMIT_BYTES,
  PLUGIN_SECRET_HEADER,
  pluginHttp
};
export type { TParsedPluginUrl };
