import type { PluginContext } from '@pulse/plugin-sdk';
import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'path';
import { initTest } from '../../__tests__/helpers';
import { testsBaseUrl } from '../../__tests__/setup';
import {
  _resetAll,
  consumeRateLimit,
  pluginHttpIdRateLimit,
  pluginHttpRateLimit
} from '../../http/rate-limit-core';
import { PLUGINS_PATH } from '../../helpers/paths';
import {
  MAX_ROUTES_PER_PLUGIN,
  PLUGIN_HTTP_BODY_LIMIT_BYTES,
  PLUGIN_SECRET_HEADER,
  normalizePluginRoutePath,
  parsePluginHttpUrl,
  pluginHttp
} from '../http';
import { pluginManager } from '..';

/**
 * Plugin HTTP ingress (`ctx.http.register` → `/plugins/<id>/<path>`).
 * The fixture plugin below is loaded through the real loader and its
 * routes are hit over the test HTTP server, so the mount, the secret
 * check, the body cap and the handler envelope are all exercised
 * end-to-end. `http/rate-limit` is replaced by the test preload (every
 * suite would otherwise 429), so the budget itself is asserted on the
 * core limiter with the plugin configs, the way rate-limit.test.ts does.
 */

declare global {
  // eslint-disable-next-line no-var
  var __pluginHttpCtx: Record<string, PluginContext> | undefined;
}

const FIXTURE_SOURCE = `
  export const onLoad = (ctx) => {
    globalThis.__pluginHttpCtx ??= {};
    globalThis.__pluginHttpCtx[ctx.path.split('/').pop()] = ctx;

    ctx.http.register('echo', (request) => ({
      status: 200,
      body: {
        method: request.method,
        path: request.path,
        query: request.query,
        body: request.body,
        contentType: request.headers['content-type'] ?? null,
        sawSecret: ${JSON.stringify(PLUGIN_SECRET_HEADER)} in request.headers
      },
      headers: { 'x-custom': 'yes', 'set-cookie': 'a=b', 'Content-Length': '1' }
    }));
    ctx.http.register('/text/', () => ({ status: 201, body: 'plain answer' }));
    ctx.http.register('empty', () => ({ status: 204 }));
    ctx.http.register('boom', () => { throw new Error('kaboom'); });
    ctx.http.register('garbage', () => 'not an envelope');
  };
`;

const writePlugin = async (id: string, entrySource: string, sdk = '^0.2') => {
  const dir = path.join(PLUGINS_PATH, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      pulse: { entry: 'index.js', author: 'test', description: 'http test plugin', sdk }
    })
  );
  await fs.writeFile(path.join(dir, 'index.js'), entrySource);

  return async () => {
    await pluginManager.unload(id);
    await fs.rm(dir, { recursive: true, force: true });
    delete globalThis.__pluginHttpCtx?.[id];
  };
};

const loadFixture = async (id: string, source = FIXTURE_SOURCE) => {
  const cleanup = await writePlugin(id, source);
  await pluginManager.togglePlugin(id, true);

  if (!pluginManager.isPluginLoaded(id)) {
    await cleanup();
    throw new Error(
      `fixture did not load: ${(await pluginManager.getPluginInfo(id)).loadError}`
    );
  }

  return cleanup;
};

const secretOf = async (id: string) => {
  const { httpSecret } = await pluginManager.getPluginSettings(id);

  if (!httpSecret) throw new Error('no http secret');

  return httpSecret;
};

const call = (
  id: string,
  route: string,
  init: { method?: 'GET' | 'POST'; secret?: string; body?: string; contentType?: string } = {}
) =>
  fetch(`${testsBaseUrl}/plugins/${id}/${route}`, {
    method: init.method ?? 'POST',
    headers: {
      ...(init.secret !== undefined ? { [PLUGIN_SECRET_HEADER]: init.secret } : {}),
      ...(init.contentType !== undefined ? { 'Content-Type': init.contentType } : {})
    },
    body: init.body
  });

afterEach(() => {
  _resetAll();
});

describe('plugin HTTP ingress — secret', () => {
  test('a route is refused without the secret, with a wrong one, and served with the right one', async () => {
    const id = 'http-secret';
    const cleanup = await loadFixture(id);

    try {
      const secret = await secretOf(id);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);

      const missing = await call(id, 'echo', { body: '{}', contentType: 'application/json' });
      expect(missing.status).toBe(401);

      const wrong = await call(id, 'echo', {
        // Flip the last character so the forged value can never equal the
        // minted one (a trailing '0' replaced by '0' would be the real secret).
        secret: `${secret.slice(0, -1)}${secret.endsWith('0') ? '1' : '0'}`,
        body: '{}',
        contentType: 'application/json'
      });
      expect(wrong.status).toBe(401);

      const ok = await call(id, 'echo', {
        secret,
        body: JSON.stringify({ hello: 'world' }),
        contentType: 'application/json'
      });
      expect(ok.status).toBe(200);
    } finally {
      await cleanup();
    }
  });

  test('the secret is readable by the instance owner through plugins.getSettings and by nobody else', async () => {
    const id = 'http-secret-route';
    const cleanup = await loadFixture(id);

    try {
      const { caller: owner } = await initTest(1);
      const settings = await owner.plugins.getSettings({ pluginId: id });
      expect(settings.httpSecret).toBe(await secretOf(id));
      // The reserved storage key never leaks into the editable values.
      expect(Object.keys(settings.values).some((k) => k.startsWith('__'))).toBe(false);

      const { caller: member } = await initTest(2);
      await expect(member.plugins.getSettings({ pluginId: id })).rejects.toThrow(
        'Only the instance owner'
      );
    } finally {
      await cleanup();
    }
  });

  test('the secret survives unload + reload (it is persisted, not re-minted)', async () => {
    const id = 'http-secret-stable';
    const cleanup = await loadFixture(id);

    try {
      const first = await secretOf(id);

      await pluginManager.togglePlugin(id, false);
      expect(pluginManager.isPluginLoaded(id)).toBe(false);
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);

      expect(await secretOf(id)).toBe(first);

      const response = await call(id, 'empty', { method: 'GET', secret: first });
      expect(response.status).toBe(204);
    } finally {
      await cleanup();
    }
  });

  test('a plugin that never registered a route has no secret', async () => {
    const id = 'http-no-routes';
    const cleanup = await writePlugin(id, 'export const onLoad = () => {};');

    try {
      await pluginManager.togglePlugin(id, true);
      const { httpSecret } = await pluginManager.getPluginSettings(id);
      expect(httpSecret).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe('plugin HTTP ingress — request envelope', () => {
  test('POST with JSON: method, path, query, parsed body and headers minus the secret', async () => {
    const id = 'http-envelope';
    const cleanup = await loadFixture(id);

    try {
      const secret = await secretOf(id);
      const response = await call(id, 'echo?a=1&b=two&a=3', {
        secret,
        body: JSON.stringify({ n: 42, list: [1, 2] }),
        contentType: 'application/json; charset=utf-8'
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        method: 'POST',
        path: 'echo',
        query: { a: '3', b: 'two' },
        body: { n: 42, list: [1, 2] },
        contentType: 'application/json; charset=utf-8',
        sawSecret: false
      });
      // Handler headers: custom ones pass, framing/security ones are dropped.
      expect(response.headers.get('x-custom')).toBe('yes');
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('a non-JSON body arrives as text; invalid JSON is a 400; GET has a null body', async () => {
    const id = 'http-bodies';
    const cleanup = await loadFixture(id);

    try {
      const secret = await secretOf(id);

      const text = await call(id, 'echo', { secret, body: 'raw payload', contentType: 'text/plain' });
      expect(text.status).toBe(200);
      expect(((await text.json()) as { body: unknown }).body).toBe('raw payload');

      const bad = await call(id, 'echo', { secret, body: '{not json', contentType: 'application/json' });
      expect(bad.status).toBe(400);

      const get = await call(id, 'echo', { method: 'GET', secret });
      expect(get.status).toBe(200);
      expect((await get.json()) as object).toMatchObject({ method: 'GET', body: null });
    } finally {
      await cleanup();
    }
  });

  test('a string body is served as text/plain; an empty envelope sends nothing; a thrown handler is a 500 in the plugin log', async () => {
    const id = 'http-answers';
    const cleanup = await loadFixture(id);

    try {
      const secret = await secretOf(id);

      const text = await call(id, 'text', { method: 'GET', secret });
      expect(text.status).toBe(201);
      expect(text.headers.get('content-type')).toContain('text/plain');
      expect(await text.text()).toBe('plain answer');

      const empty = await call(id, 'empty', { method: 'GET', secret });
      expect(empty.status).toBe(204);
      expect(await empty.text()).toBe('');

      const boom = await call(id, 'boom', { method: 'GET', secret });
      expect(boom.status).toBe(500);
      expect(((await boom.json()) as { error: string }).error).toBe('Plugin handler failed');
      expect(
        pluginManager.getLogs(id).some((l) => l.type === 'error' && l.message.includes('kaboom'))
      ).toBe(true);

      const garbage = await call(id, 'garbage', { method: 'GET', secret });
      expect(garbage.status).toBe(500);
    } finally {
      await cleanup();
    }
  });

  test('the body is capped at 1 MiB: one byte over is a 413, exactly at the cap is served', async () => {
    const id = 'http-body-cap';
    const cleanup = await loadFixture(id);

    try {
      const secret = await secretOf(id);

      const over = await call(id, 'echo', {
        secret,
        body: 'x'.repeat(PLUGIN_HTTP_BODY_LIMIT_BYTES + 1),
        contentType: 'text/plain'
      });
      expect(over.status).toBe(413);

      const atCap = await call(id, 'echo', {
        secret,
        body: 'x'.repeat(PLUGIN_HTTP_BODY_LIMIT_BYTES),
        contentType: 'text/plain'
      });
      expect(atCap.status).toBe(200);
    } finally {
      await cleanup();
    }
  });
});

describe('plugin HTTP ingress — routing', () => {
  test('unknown route, unknown plugin and an unloaded plugin all answer 404 (no inventory oracle)', async () => {
    const id = 'http-routing';
    const cleanup = await loadFixture(id);

    try {
      const secret = await secretOf(id);

      expect((await call(id, 'nope', { method: 'GET', secret })).status).toBe(404);
      expect((await call('no-such-plugin', 'echo', { method: 'GET', secret })).status).toBe(404);
      expect((await fetch(`${testsBaseUrl}/plugins/${id}`)).status).toBe(404);
      expect((await fetch(`${testsBaseUrl}/plugins/../etc/passwd`)).status).toBe(404);

      await pluginManager.togglePlugin(id, false);
      expect(pluginHttp.routeCount(id)).toBe(0);
      expect((await call(id, 'echo', { method: 'GET', secret })).status).toBe(404);
    } finally {
      await cleanup();
    }
  });

  test('route paths are canonicalised and bounded; a bad path fails onLoad', async () => {
    expect(normalizePluginRoutePath('/a/b/')).toBe('a/b');
    expect(normalizePluginRoutePath('hook.v1')).toBe('hook.v1');
    expect(() => normalizePluginRoutePath('../x')).toThrow('Invalid route path segment');
    expect(() => normalizePluginRoutePath('a//b/..')).toThrow('Invalid route path segment');
    expect(() => normalizePluginRoutePath('')).toThrow('at least one segment');
    expect(() => normalizePluginRoutePath('x'.repeat(129))).toThrow('at most 128');

    expect(parsePluginHttpUrl('/plugins/my-plugin/hook?x=1#frag')).toEqual({
      pluginId: 'my-plugin',
      path: 'hook',
      query: { x: '1' }
    });
    expect(parsePluginHttpUrl('/plugins/bad id/hook')).toBeUndefined();
    expect(parsePluginHttpUrl('/plugins/x/')).toBeUndefined();

    const id = 'http-bad-path';
    const cleanup = await writePlugin(
      id,
      "export const onLoad = (ctx) => { ctx.http.register('../escape', () => ({ status: 200 })); };"
    );

    try {
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(false);
      expect((await pluginManager.getPluginInfo(id)).loadError).toContain('Invalid route path');
    } finally {
      await cleanup();
    }
  });

  test(`a plugin may register at most ${MAX_ROUTES_PER_PLUGIN} routes; re-registering a path replaces it`, async () => {
    const id = 'http-route-cap';
    const cleanup = await writePlugin(
      id,
      `export const onLoad = (ctx) => {
        for (let i = 0; i < ${MAX_ROUTES_PER_PLUGIN}; i++) ctx.http.register('r' + i, () => ({ status: 200 }));
        ctx.http.register('r0', () => ({ status: 202 }));
        globalThis.__routeCapError = null;
        try { ctx.http.register('one-too-many', () => ({ status: 200 })); }
        catch (e) { globalThis.__routeCapError = e.message; }
      };`
    );

    try {
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);
      expect(pluginHttp.routeCount(id)).toBe(MAX_ROUTES_PER_PLUGIN);
      expect((globalThis as { __routeCapError?: string }).__routeCapError).toContain(
        `at most ${MAX_ROUTES_PER_PLUGIN}`
      );

      const secret = await secretOf(id);
      expect((await call(id, 'r0', { method: 'GET', secret })).status).toBe(202);
    } finally {
      delete (globalThis as { __routeCapError?: string }).__routeCapError;
      await cleanup();
    }
  });

  test('the per-source and per-plugin budgets refuse the request past their limits', () => {
    const perSource = `203.0.113.7:/plugins/some-plugin`;
    for (let i = 0; i < pluginHttpRateLimit.maxRequests; i++) {
      expect(consumeRateLimit(perSource, pluginHttpRateLimit).allowed).toBe(true);
    }
    const refused = consumeRateLimit(perSource, pluginHttpRateLimit);
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) expect(refused.retryAfterSec).toBeGreaterThan(0);

    const perPlugin = 'plugin-id:some-plugin';
    for (let i = 0; i < pluginHttpIdRateLimit.maxRequests; i++) {
      expect(consumeRateLimit(perPlugin, pluginHttpIdRateLimit).allowed).toBe(true);
    }
    expect(consumeRateLimit(perPlugin, pluginHttpIdRateLimit).allowed).toBe(false);
    // The per-plugin budget is wider than the per-source one by design.
    expect(pluginHttpIdRateLimit.maxRequests).toBeGreaterThan(pluginHttpRateLimit.maxRequests);
  });
});
