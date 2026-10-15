import { PLUGIN_SDK_VERSION } from '@pulse/plugin-sdk';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { settings, users } from '../../db/schema';
import { PLUGINS_PATH } from '../../helpers/paths';
import { eventBus } from '../event-bus';
import { pluginManager } from '..';

type TFixture = {
  id: string;
  sdk?: string;
  entrySource: string;
};

// Writes a throwaway plugin under PLUGINS_PATH. Plugin ids are unique per
// test because the manager caches enabled-state in memory across the
// per-test TRUNCATE.
const writePlugin = async ({ id, sdk, entrySource }: TFixture) => {
  const dir = path.join(PLUGINS_PATH, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      pulse: {
        entry: 'index.js',
        author: 'test',
        description: 'test plugin',
        ...(sdk !== undefined ? { sdk } : {})
      }
    })
  );
  await fs.writeFile(path.join(dir, 'index.js'), entrySource);

  return () => fs.rm(dir, { recursive: true, force: true });
};

const enablePluginsSetting = async () => {
  await getTestDb().update(settings).set({ enablePlugins: true });
};

describe('plugin manager', () => {
  test('refuses to load a plugin whose pulse.sdk range the SDK does not satisfy', async () => {
    await initTest(1);
    await enablePluginsSetting();

    const id = 'sdk-gate-incompatible';
    // If the gate failed and the module were imported, this throw would
    // replace the loadError with "imported" — so the assertion below also
    // proves the entry file was never evaluated.
    const cleanup = await writePlugin({
      id,
      sdk: '>=9',
      entrySource: "throw new Error('imported');"
    });

    try {
      await pluginManager.togglePlugin(id, true);

      const info = await pluginManager.getPluginInfo(id);
      expect(info.loadError).toBe(
        `requires @pulse/plugin-sdk >=9, server provides ${PLUGIN_SDK_VERSION}`
      );
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });

  test('loads a plugin whose pulse.sdk range matches, and one without a range', async () => {
    await initTest(1);
    await enablePluginsSetting();

    const major = PLUGIN_SDK_VERSION.split('.')[0];
    const minor = PLUGIN_SDK_VERSION.split('.')[1];
    const withRange = 'sdk-gate-compatible';
    const withoutRange = 'sdk-gate-unspecified';
    const cleanups = [
      await writePlugin({
        id: withRange,
        sdk: `^${major}.${minor}`,
        entrySource: 'export const onLoad = () => {};'
      }),
      await writePlugin({
        id: withoutRange,
        entrySource: 'export const onLoad = () => {};'
      })
    ];

    try {
      await pluginManager.togglePlugin(withRange, true);
      await pluginManager.togglePlugin(withoutRange, true);

      expect((await pluginManager.getPluginInfo(withRange)).loadError).toBeUndefined();
      expect((await pluginManager.getPluginInfo(withoutRange)).loadError).toBeUndefined();
    } finally {
      await pluginManager.unload(withRange);
      await pluginManager.unload(withoutRange);
      for (const cleanup of cleanups) await cleanup();
    }
  });

  test('keeps the load error of a plugin whose onLoad throws', async () => {
    await initTest(1);
    await enablePluginsSetting();

    const id = 'onload-throws';
    const cleanup = await writePlugin({
      id,
      entrySource: "export const onLoad = () => { throw new Error('boom'); };"
    });

    try {
      await pluginManager.togglePlugin(id, true);

      // load() unloads a plugin that failed to load; the error must survive
      // that unload so plugins.get can show why it is not running.
      expect((await pluginManager.getPluginInfo(id)).loadError).toBe('boom');
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });

  test('servers.leave emits user:left with the server id', async () => {
    await initTest(1);
    const { caller: caller2 } = await initTest(2);

    const received: unknown[] = [];
    const handler = (payload: unknown) => {
      received.push(payload);
    };
    eventBus.on('user:left', handler);

    try {
      await caller2.servers.leave({ serverId: 1 });
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      eventBus.off('user:left', handler);
    }

    const [user2] = await getTestDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, 2));

    expect(received).toEqual([
      { userId: 2, username: user2!.name, serverId: 1 }
    ]);
  });

  test('users.kick and users.ban emit user:left with the server id', async () => {
    const { caller } = await initTest(1);
    await initTest(2);
    await initTest(3);

    const received: unknown[] = [];
    const handler = (payload: unknown) => {
      received.push(payload);
    };
    eventBus.on('user:left', handler);

    try {
      await caller.users.kick({ userId: 2, reason: 'kicked' });
      await caller.users.ban({ userId: 3, reason: 'banned' });
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      eventBus.off('user:left', handler);
    }

    const names = await getTestDb()
      .select({ id: users.id, name: users.name })
      .from(users);
    const nameOf = (id: number) => names.find((u) => u.id === id)!.name;

    expect(received).toEqual([
      { userId: 2, username: nameOf(2), serverId: 1 },
      { userId: 3, username: nameOf(3), serverId: 1 }
    ]);
  });

  test('others.joinServer emits user:joined with the server id', async () => {
    const received: unknown[] = [];
    const handler = (payload: unknown) => {
      received.push(payload);
    };
    eventBus.on('user:joined', handler);

    try {
      await initTest(2);
    } finally {
      eventBus.off('user:joined', handler);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ userId: 2, serverId: 1 });
  });
});
