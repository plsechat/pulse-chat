import type { PluginContext } from '@pulse/plugin-sdk';
import { isPluginActionError } from '@pulse/plugin-sdk';
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'path';
import { initTest } from '../../__tests__/helpers';
import { PLUGINS_PATH } from '../../helpers/paths';
import { pluginManager } from '..';

/**
 * SDK 0.4 loader surface: `ctx.server.notify` delivered to in-process
 * subscribers (bounded, scoped to the plugin, dropped from a stale
 * context), the `onPluginLoaded` / `onPluginUnloaded` hooks, and hot
 * reload on toggle (a changed entry file runs; an unchanged one is the
 * cached module; older runtime copies are swept).
 */

declare global {
  // eslint-disable-next-line no-var
  var __lifecycleCtx: Record<string, PluginContext> | undefined;
  // eslint-disable-next-line no-var
  var __hotVersion: Record<string, string> | undefined;
}

const STASH_SOURCE = `
  export const onLoad = (ctx) => {
    globalThis.__lifecycleCtx ??= {};
    globalThis.__lifecycleCtx[ctx.path.split('/').pop()] = ctx;
  };
`;

const hotSource = (version: string) => `
  export const onLoad = (ctx) => {
    globalThis.__hotVersion ??= {};
    globalThis.__hotVersion[ctx.path.split('/').pop()] = '${version}';
  };
`;

const writePlugin = async (id: string, entrySource: string) => {
  const dir = path.join(PLUGINS_PATH, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      pulse: { entry: 'index.js', author: 'test', description: 'lifecycle test plugin', sdk: '^0.4' }
    })
  );
  await fs.writeFile(path.join(dir, 'index.js'), entrySource);

  return async () => {
    await pluginManager.unload(id);
    await fs.rm(dir, { recursive: true, force: true });
    delete globalThis.__lifecycleCtx?.[id];
    delete globalThis.__hotVersion?.[id];
  };
};

const ctxOf = (id: string) => globalThis.__lifecycleCtx![id]!;

const thrown = (run: () => void) => {
  try {
    run();
  } catch (error) {
    if (isPluginActionError(error)) return { code: error.code, message: error.message };
    throw error;
  }
  throw new Error('expected a throw');
};

const logText = (id: string) => pluginManager.getLogs(id).map((l) => l.message).join('\n');

describe('ctx.server.notify', () => {
  test('reaches every subscriber of the plugin and topic in order; a failing one is logged and does not stop the rest; unsubscribe works', async () => {
    await initTest(1);
    const id = 'notify-delivery';
    const cleanup = await writePlugin(id, STASH_SOURCE);
    const received: string[] = [];
    const offs: (() => void)[] = [];

    try {
      await pluginManager.togglePlugin(id, true);

      offs.push(pluginManager.onNotify(id, 'ping', (payload) => {
        received.push(`a:${JSON.stringify(payload)}`);
      }));
      offs.push(pluginManager.onNotify(id, 'ping', () => {
        throw new Error('sync boom');
      }));
      offs.push(pluginManager.onNotify(id, 'ping', async () => {
        throw new Error('async boom');
      }));
      offs.push(pluginManager.onNotify(id, 'ping', (payload) => {
        received.push(`b:${JSON.stringify(payload)}`);
      }));
      offs.push(pluginManager.onNotify('someone-else', 'ping', () => {
        received.push('wrong plugin');
      }));
      offs.push(pluginManager.onNotify(id, 'other', () => {
        received.push('wrong topic');
      }));

      ctxOf(id).server.notify('ping', { n: 1 });
      await new Promise((r) => setTimeout(r, 0));

      expect(received).toEqual(['a:{"n":1}', 'b:{"n":1}']);
      expect(logText(id)).toContain("A server subscriber to 'ping' failed: sync boom");
      expect(logText(id)).toContain("A server subscriber to 'ping' failed: async boom");

      // No payload is fine; an unsubscribed handler is silent.
      offs[0]!();
      ctxOf(id).server.notify('ping');
      expect(received).toEqual(['a:{"n":1}', 'b:{"n":1}', 'b:undefined']);

      // Nothing listening: dropped with a note in the plugin log.
      ctxOf(id).server.notify('nobody');
      expect(logText(id)).toContain("Nothing on the server listens to 'nobody'");
    } finally {
      for (const off of offs) off();
      await cleanup();
    }
  });

  test('bounds: topic 1–64 chars, payload at most 16 KiB as JSON, and it must serialise', async () => {
    await initTest(1);
    const id = 'notify-bounds';
    const cleanup = await writePlugin(id, STASH_SOURCE);
    let delivered = 0;
    const off = pluginManager.onNotify(id, 'x'.repeat(64), () => {
      delivered++;
    });

    try {
      await pluginManager.togglePlugin(id, true);
      const ctx = ctxOf(id);

      expect(thrown(() => ctx.server.notify('')).code).toBe('BAD_REQUEST');
      expect(thrown(() => ctx.server.notify('x'.repeat(65))).code).toBe('BAD_REQUEST');
      expect(thrown(() => ctx.server.notify('x'.repeat(64), 'y'.repeat(16 * 1024))).message).toContain(
        'payload may not exceed 16384 bytes'
      );
      expect(thrown(() => ctx.server.notify('x'.repeat(64), () => undefined)).message).toContain(
        'serialise'
      );
      expect(delivered).toBe(0);

      // 16 KiB exactly, as JSON (the quotes count), passes.
      ctx.server.notify('x'.repeat(64), 'y'.repeat(16 * 1024 - 2));
      expect(delivered).toBe(1);
    } finally {
      off();
      await cleanup();
    }
  });

  test('a context from an unloaded instance of the plugin is stale: its signals are dropped; the next load signals again', async () => {
    await initTest(1);
    const id = 'notify-stale';
    const cleanup = await writePlugin(id, STASH_SOURCE);
    let delivered = 0;
    const off = pluginManager.onNotify(id, 'ping', () => {
      delivered++;
    });

    try {
      await pluginManager.togglePlugin(id, true);
      const stale = ctxOf(id);
      stale.server.notify('ping');
      expect(delivered).toBe(1);

      await pluginManager.togglePlugin(id, false);
      stale.server.notify('ping');
      expect(delivered).toBe(1);
      expect(logText(id)).toContain("Dropped 'ping' from an unloaded instance");

      await pluginManager.togglePlugin(id, true);
      stale.server.notify('ping');
      expect(delivered).toBe(1);
      ctxOf(id).server.notify('ping');
      expect(delivered).toBe(2);
    } finally {
      off();
      await cleanup();
    }
  });
});

describe('onPluginLoaded / onPluginUnloaded', () => {
  test('fire after a load and after an unload with the plugin id, are awaited, survive a failing listener, and unsubscribe', async () => {
    await initTest(1);
    const id = 'lifecycle-hooks';
    const cleanup = await writePlugin(id, STASH_SOURCE);
    const seen: string[] = [];
    let settled = false;
    const offs = [
      pluginManager.onPluginLoaded(() => {
        throw new Error('listener boom');
      }),
      pluginManager.onPluginLoaded(async (pluginId) => {
        await new Promise((r) => setTimeout(r, 10));
        settled = true;
        seen.push(`loaded:${pluginId}`);
      }),
      pluginManager.onPluginUnloaded((pluginId) => {
        seen.push(`unloaded:${pluginId}`);
      })
    ];

    try {
      await pluginManager.togglePlugin(id, true);
      // The toggle waited for the listener, boom and all.
      expect(settled).toBe(true);
      expect(seen).toEqual([`loaded:${id}`]);

      await pluginManager.togglePlugin(id, false);
      expect(seen).toEqual([`loaded:${id}`, `unloaded:${id}`]);

      // Unloading what is not loaded fires nothing.
      await pluginManager.unload(id);
      expect(seen).toHaveLength(2);

      for (const off of offs) off();
      await pluginManager.togglePlugin(id, true);
      await pluginManager.togglePlugin(id, false);
      expect(seen).toHaveLength(2);
    } finally {
      for (const off of offs) off();
      await cleanup();
    }
  });

  test('a plugin whose onLoad throws is never reported as loaded', async () => {
    await initTest(1);
    const id = 'lifecycle-failed-load';
    const cleanup = await writePlugin(id, "export const onLoad = () => { throw new Error('nope'); };");
    const seen: string[] = [];
    const offs = [
      pluginManager.onPluginLoaded((pluginId) => {
        seen.push(`loaded:${pluginId}`);
      }),
      pluginManager.onPluginUnloaded((pluginId) => {
        seen.push(`unloaded:${pluginId}`);
      })
    ];

    try {
      await pluginManager.togglePlugin(id, true);
      expect((await pluginManager.getPluginInfo(id)).loadError).toBe('nope');
      expect(seen).toEqual([]);
    } finally {
      for (const off of offs) off();
      await cleanup();
    }
  });
});

describe('hot reload on toggle', () => {
  const entryOf = (id: string) => path.join(PLUGINS_PATH, id, 'index.js');
  const runtimeDirOf = (id: string) => path.join(PLUGINS_PATH, id, '.runtime');
  const runtimeFiles = async (id: string) => {
    try {
      return (await fs.readdir(runtimeDirOf(id))).sort();
    } catch {
      return [];
    }
  };
  /** Rewrite the entry with a modification time the loader cannot mistake for the previous one. */
  const restage = async (id: string, source: string, secondsAhead: number) => {
    await fs.writeFile(entryOf(id), source);
    const when = new Date(Date.now() + secondsAhead * 1000);
    await fs.utimes(entryOf(id), when, when);
    return Math.floor((await fs.stat(entryOf(id))).mtimeMs);
  };

  test('a changed entry file runs on the next toggle from a runtime copy; an unchanged one reuses it; older copies are swept', async () => {
    await initTest(1);
    const id = 'hot-reload';
    const cleanup = await writePlugin(id, hotSource('v1'));

    try {
      await pluginManager.togglePlugin(id, true);
      expect(globalThis.__hotVersion![id]).toBe('v1');
      expect(await runtimeFiles(id)).toEqual([]);
      await pluginManager.togglePlugin(id, false);

      const mtime2 = await restage(id, hotSource('v2'), 5);
      await pluginManager.togglePlugin(id, true);
      expect(globalThis.__hotVersion![id]).toBe('v2');
      expect(await runtimeFiles(id)).toEqual([`index.${mtime2}.js`]);
      expect(logText(id)).toContain(`running .runtime/index.${mtime2}.js`);
      // The manifest's entry is still the original path.
      expect((await pluginManager.getPluginInfo(id)).entry).toBe(entryOf(id));

      // Unchanged: the same copy (the cached module), no new file.
      delete globalThis.__hotVersion![id];
      await pluginManager.togglePlugin(id, false);
      await pluginManager.togglePlugin(id, true);
      expect(globalThis.__hotVersion![id]).toBe('v2');
      expect(await runtimeFiles(id)).toEqual([`index.${mtime2}.js`]);

      await pluginManager.togglePlugin(id, false);
      const mtime3 = await restage(id, hotSource('v3'), 10);
      await pluginManager.togglePlugin(id, true);
      expect(globalThis.__hotVersion![id]).toBe('v3');
      expect(await runtimeFiles(id)).toEqual([`index.${mtime3}.js`]);
    } finally {
      await cleanup();
    }
  });

  test('a broken new version is a load error; the fix after it loads', async () => {
    await initTest(1);
    const id = 'hot-reload-broken';
    const cleanup = await writePlugin(id, hotSource('v1'));

    try {
      await pluginManager.togglePlugin(id, true);
      expect(globalThis.__hotVersion![id]).toBe('v1');
      await pluginManager.togglePlugin(id, false);

      await restage(id, 'export const onLoad = (ctx) => { throw new Error("v2 is broken"); };', 5);
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(false);
      expect((await pluginManager.getPluginInfo(id)).loadError).toBe('v2 is broken');

      await pluginManager.togglePlugin(id, false);
      await restage(id, hotSource('v3'), 10);
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);
      expect(globalThis.__hotVersion![id]).toBe('v3');
      expect((await pluginManager.getPluginInfo(id)).loadError).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
