import type { PluginContext, TPluginFetchResponse } from '@pulse/plugin-sdk';
import { z } from 'zod';
import { federationFetch } from '../utils/federation-fetch';
import { parseActionInput, PluginActionError } from './errors';

/**
 * `ctx.fetch` — outbound HTTP for plugins, through the same hardened
 * client the server uses for every user-controlled URL: scheme and
 * private-range checks with DNS pinning, redirects refused, a per-host
 * outbound rate limit and a capped body. A plugin that hand-rolls
 * `fetch` bypasses all of that; the loader does not sandbox, so the
 * README calls raw `fetch` unsupported rather than impossible.
 *
 * The rate limit is the plugin's own: 60 a minute per host, in a bucket
 * scoped to the plugin id, so a bridge paging through a remote API
 * neither drains the federation budget for that host nor gets drained
 * by another plugin talking to the same place.
 */

const MAX_URL_LENGTH = 2048;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_MAX_BYTES = 64 * 1024 * 1024;
const MAX_HEADERS = 64;
const MAX_HEADER_LENGTH = 8192;
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const initSchema = z
  .object({
    method: z.string().regex(/^[A-Z]{3,10}$/, 'method must be an upper-case verb').optional(),
    headers: z
      .record(z.string().max(256), z.string().max(MAX_HEADER_LENGTH))
      .refine((h) => Object.keys(h).length <= MAX_HEADERS, `At most ${MAX_HEADERS} headers`)
      .optional(),
    body: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
    maxBytes: z.number().int().min(1).max(MAX_MAX_BYTES).optional()
  })
  .refine(
    (v) =>
      v.body === undefined ||
      (typeof v.body === 'string' ? Buffer.byteLength(v.body) : v.body.byteLength) <=
        MAX_BODY_BYTES,
    `body may not exceed ${MAX_BODY_BYTES} bytes`
  );

const createPluginFetch = (pluginId: string): PluginContext['fetch'] => {
  const rateLimitScope = `plugin:${pluginId}`;

  return async (rawUrl, rawInit) => {
    const url = parseActionInput(
      z.string().max(MAX_URL_LENGTH).regex(/^https?:\/\//i, 'url must be http(s)'),
      rawUrl
    );
    const init = parseActionInput(initSchema, rawInit ?? {});

    let response: Awaited<ReturnType<typeof federationFetch>>;

    try {
      response = await federationFetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        maxBytes: init.maxBytes ?? DEFAULT_MAX_BYTES,
        rateLimitScope,
        signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      });
    } catch (error) {
      throw new PluginActionError(
        'BAD_REQUEST',
        `fetch ${url} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });

    const result: TPluginFetchResponse = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers,
      bytes: () => response.bytes(),
      text: () => response.text(),
      json: <T = unknown>() => response.json<T>()
    };

    return result;
  };
};

export { createPluginFetch };
