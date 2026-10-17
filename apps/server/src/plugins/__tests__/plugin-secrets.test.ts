import type { PluginContext, PluginSettings } from '@pulse/plugin-sdk';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { pluginData } from '../../db/schema';
import { PLUGINS_PATH } from '../../helpers/paths';
import { isSealedSetting, unsealPluginSecret } from '../secret-settings';
import { pluginManager } from '..';

/**
 * `secret` settings (SDK 0.3): the plaintext reaches the plugin's
 * `settings.get` and nothing else — the row holds a sealed envelope,
 * the settings route says `{ set }`, the log never carries the value,
 * `null` clears it, and a value stored in the clear before the setting
 * became a secret is sealed on the first load.
 */

declare global {
  // eslint-disable-next-line no-var
  var __secretPlugins:
    | Record<string, { ctx: PluginContext; settings: PluginSettings }>
    | undefined;
}

const SOURCE = `
  export const onLoad = async (ctx) => {
    const settings = await ctx.settings.register([
      { key: 'token', name: 'Token', type: 'secret', defaultValue: '' },
      { key: 'label', name: 'Label', type: 'string', defaultValue: 'x' }
    ]);
    globalThis.__secretPlugins ??= {};
    globalThis.__secretPlugins[ctx.path.split('/').pop()] = { ctx, settings };
  };
`;

// Ids are unique per test: the manager caches enabled-state in memory
// across the per-test TRUNCATE, and the runtime caches the module.
const writePlugin = async (id: string) => {
  const dir = path.join(PLUGINS_PATH, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      pulse: { entry: 'index.js', author: 'test', description: 'secret test plugin', sdk: '^0.3' }
    })
  );
  await fs.writeFile(path.join(dir, 'index.js'), SOURCE);

  return async () => {
    await pluginManager.unload(id);
    await fs.rm(dir, { recursive: true, force: true });
    delete globalThis.__secretPlugins?.[id];
  };
};

const stash = (id: string) => globalThis.__secretPlugins![id]!;

const storedSettings = async (id: string): Promise<Record<string, unknown>> => {
  const [row] = await getTestDb()
    .select({ settings: pluginData.settings })
    .from(pluginData)
    .where(eq(pluginData.pluginId, id));
  return row?.settings ?? {};
};

const logText = (id: string) => pluginManager.getLogs(id).map((l) => l.message).join('\n');

describe('secret plugin settings', () => {
  test('round-trips to the plugin only: sealed in the row, masked on the route, absent from the log; null clears it', async () => {
    await initTest(1);
    const id = 'secret-roundtrip';
    const cleanup = await writePlugin(id);

    try {
      await pluginManager.togglePlugin(id, true);
      expect(stash(id).settings.get('token')).toBe('');
      expect((await pluginManager.getPluginSettings(id)).values).toEqual({
        token: { set: false },
        label: 'x'
      });

      await pluginManager.updatePluginSetting(id, 'token', '  tok-abc\n');

      expect(stash(id).settings.get('token')).toBe('tok-abc');

      const stored = await storedSettings(id);
      expect(isSealedSetting(stored.token)).toBe(true);
      expect(JSON.stringify(stored)).not.toContain('tok-abc');
      expect(unsealPluginSecret(stored.token as { sealed: string })).toBe('tok-abc');
      expect(stored.label).toBe('x');

      const response = await pluginManager.getPluginSettings(id);
      expect(response.values).toEqual({ token: { set: true }, label: 'x' });
      expect(JSON.stringify(response)).not.toContain('tok-abc');
      expect(response.definitions.find((d) => d.key === 'token')?.type).toBe('secret');
      expect(logText(id)).not.toContain('tok-abc');
      expect(logText(id)).toContain("Secret setting 'token' replaced");

      await pluginManager.updatePluginSetting(id, 'token', null);
      expect(stash(id).settings.get('token')).toBe('');
      expect((await storedSettings(id)).token).toBe('');
      expect((await pluginManager.getPluginSettings(id)).values.token).toEqual({ set: false });
      expect(logText(id)).toContain("Secret setting 'token' cleared");

      // Only a secret can be cleared, and only with text.
      await expect(pluginManager.updatePluginSetting(id, 'label', null)).rejects.toThrow(
        'cannot be cleared'
      );
      await expect(pluginManager.updatePluginSetting(id, 'token', 5)).rejects.toThrow(
        'takes a string or null'
      );
    } finally {
      await cleanup();
    }
  });

  test('the plaintext comes back from the sealed row on the next load; settings.set from the plugin seals too', async () => {
    await initTest(1);
    const id = 'secret-reload';
    const cleanup = await writePlugin(id);

    try {
      await pluginManager.togglePlugin(id, true);
      await pluginManager.updatePluginSetting(id, 'token', 'tok-1');

      await pluginManager.unload(id);
      await pluginManager.load(id);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);
      expect(stash(id).settings.get('token')).toBe('tok-1');
      expect((await pluginManager.getPluginSettings(id)).values.token).toEqual({ set: true });

      stash(id).settings.set('token', 'tok-2');
      await new Promise((r) => setTimeout(r, 20));
      const stored = await storedSettings(id);
      expect(isSealedSetting(stored.token)).toBe(true);
      expect(unsealPluginSecret(stored.token as { sealed: string })).toBe('tok-2');

      // A secret takes text only, from the plugin as well.
      stash(id).settings.set('token', 42 as unknown as string);
      expect(stash(id).settings.get('token')).toBe('tok-2');
      expect(logText(id)).toContain("Setting 'token' is a secret and takes a string");
    } finally {
      await cleanup();
    }
  });

  test('a value stored in the clear before the setting became a secret is sealed on the first load', async () => {
    await initTest(1);
    const id = 'secret-migrate';
    const cleanup = await writePlugin(id);
    await getTestDb()
      .insert(pluginData)
      .values({ pluginId: id, enabled: false, serverId: 1, settings: { token: 'legacy-tok', label: 'y' } });

    try {
      await pluginManager.togglePlugin(id, true);

      expect(stash(id).settings.get('token')).toBe('legacy-tok');
      expect(stash(id).settings.get('label')).toBe('y');

      const stored = await storedSettings(id);
      expect(isSealedSetting(stored.token)).toBe(true);
      expect(JSON.stringify(stored)).not.toContain('legacy-tok');
      expect(unsealPluginSecret(stored.token as { sealed: string })).toBe('legacy-tok');
      expect(logText(id)).toContain("Setting 'token' is now a secret");
      expect(logText(id)).not.toContain('legacy-tok');
      expect((await pluginManager.getPluginSettings(id)).values.token).toEqual({ set: true });
    } finally {
      await cleanup();
    }
  });

  test('an envelope this instance cannot open is reported and treated as unset', async () => {
    await initTest(1);
    const id = 'secret-foreign';
    const cleanup = await writePlugin(id);
    await getTestDb()
      .insert(pluginData)
      .values({
        pluginId: id,
        enabled: false,
        serverId: 1,
        settings: { token: { sealed: 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' } }
      });

    try {
      await pluginManager.togglePlugin(id, true);

      expect(pluginManager.isPluginLoaded(id)).toBe(true);
      expect(stash(id).settings.get('token')).toBe('');
      expect(logText(id)).toContain("secret setting 'token' cannot be decrypted");
      expect((await pluginManager.getPluginSettings(id)).values.token).toEqual({ set: false });
    } finally {
      await cleanup();
    }
  });

  test('the routes: the instance owner sets, replaces and clears a secret and only ever reads { set }', async () => {
    const { caller } = await initTest(1);
    const id = 'secret-route';
    const cleanup = await writePlugin(id);

    try {
      await pluginManager.togglePlugin(id, true);

      await caller.plugins.updateSetting({ pluginId: id, key: 'token', value: 'tok-r1' });
      expect((await caller.plugins.getSettings({ pluginId: id })).values).toEqual({
        token: { set: true },
        label: 'x'
      });
      expect(stash(id).settings.get('token')).toBe('tok-r1');

      await caller.plugins.updateSetting({ pluginId: id, key: 'token', value: 'tok-r2' });
      expect(stash(id).settings.get('token')).toBe('tok-r2');

      await caller.plugins.updateSetting({ pluginId: id, key: 'token', value: null });
      expect((await caller.plugins.getSettings({ pluginId: id })).values.token).toEqual({ set: false });
      expect(stash(id).settings.get('token')).toBe('');

      await expect(
        caller.plugins.updateSetting({ pluginId: id, key: 'label', value: null })
      ).rejects.toThrow('cannot be cleared');
    } finally {
      await cleanup();
    }
  });
});
