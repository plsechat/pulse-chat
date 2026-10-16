import { PLUGIN_SDK_VERSION } from '@pulse/plugin-sdk';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { servers, users } from '../../db/schema';
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

// Instance-level plugin enablement is the BOOTSTRAP server row's flag
// (the `settings` copy is written by nothing).
const setInstancePlugins = async (enablePlugins: boolean) => {
  await getTestDb()
    .update(servers)
    .set({ enablePlugins })
    .where(eq(servers.id, 1));
};

const enablePluginsSetting = () => setInstancePlugins(true);

describe('plugin manager', () => {
  test('loadPlugins loads a fixture plugin when the bootstrap server row enables plugins', async () => {
    await initTest(1);
    await setInstancePlugins(true);

    const id = 'loader-bootstrap-enabled';
    const cleanup = await writePlugin({
      id,
      entrySource: 'export const onLoad = () => {};'
    });

    try {
      // Mark it enabled in plugin state without loading (toggle would
      // load it itself), then run the boot-time loader.
      await pluginManager.togglePlugin(id, true);
      await pluginManager.unload(id);
      expect(pluginManager.isPluginLoaded(id)).toBe(false);

      await pluginManager.loadPlugins();

      expect(pluginManager.isPluginLoaded(id)).toBe(true);
      const info = await pluginManager.getPluginInfo(id);
      expect(info.enabled).toBe(true);
      expect(info.loadError).toBeUndefined();
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });

  test('loadPlugins is a no-op when the bootstrap row disables plugins, but toggle still loads on explicit intent', async () => {
    await initTest(1);
    await setInstancePlugins(false);

    const id = 'loader-bootstrap-disabled';
    const cleanup = await writePlugin({
      id,
      entrySource: 'export const onLoad = () => {};'
    });

    try {
      await pluginManager.loadPlugins();
      expect(pluginManager.isPluginLoaded(id)).toBe(false);

      // togglePlugin is the instance owner saying "run this now": it
      // loads regardless of the boot-time flag.
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);
      expect((await pluginManager.getPluginInfo(id)).loadError).toBeUndefined();

      await pluginManager.togglePlugin(id, false);
      expect(pluginManager.isPluginLoaded(id)).toBe(false);
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });

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

  // Collects every emit of `events` for the duration of `run`.
  const collect = async (
    events: Parameters<typeof eventBus.on>[0][],
    run: () => Promise<unknown>
  ) => {
    const received: { event: string; payload: unknown }[] = [];
    const handlers = events.map((event) => {
      const handler = (payload: unknown) => {
        received.push({ event, payload });
      };
      eventBus.on(event, handler);
      return { event, handler };
    });
    try {
      await run();
      await new Promise((r) => setTimeout(r, 0));
    } finally {
      for (const { event, handler } of handlers) eventBus.off(event, handler);
    }
    return received;
  };

  const nameOf = async (id: number) => {
    const [row] = await getTestDb()
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, id));
    return row!.name;
  };

  test('servers.leave emits member:left (and the deprecated user:left) with the server id', async () => {
    await initTest(1);
    const { caller: caller2 } = await initTest(2);

    const received = await collect(['member:left', 'user:left'], () =>
      caller2.servers.leave({ serverId: 1 })
    );

    const payload = { userId: 2, username: await nameOf(2), serverId: 1 };
    expect(received).toEqual([
      { event: 'member:left', payload },
      { event: 'user:left', payload }
    ]);
  });

  test('users.kick and users.ban emit member:left with the server id', async () => {
    const { caller } = await initTest(1);
    await initTest(2);
    await initTest(3);

    const received = await collect(['member:left'], async () => {
      await caller.users.kick({ userId: 2, reason: 'kicked' });
      await caller.users.ban({ userId: 3, reason: 'banned' });
    });

    expect(received.map((r) => r.payload)).toEqual([
      { userId: 2, username: await nameOf(2), serverId: 1 },
      { userId: 3, username: await nameOf(3), serverId: 1 }
    ]);
  });

  test('others.openSession emits user:connected (and the deprecated user:joined), not member:joined', async () => {
    await initTest(1);
    const received = await collect(
      ['user:connected', 'user:joined', 'member:joined'],
      () => initTest(2)
    );

    const payload = { userId: 2, username: await nameOf(2), serverId: 1 };
    expect(received).toEqual([
      { event: 'user:connected', payload },
      { event: 'user:joined', payload }
    ]);
  });

  test('servers.joinByInvite and servers.joinDiscover emit member:joined, not user:connected', async () => {
    const owner = await initTest(1);
    const invite = await owner.caller.invites.add({ serverId: 1 });
    const member = await initTest(2);
    await member.caller.servers.leave({ serverId: 1 });

    const viaInvite = await collect(['member:joined', 'user:connected'], () =>
      member.caller.servers.joinByInvite({ inviteCode: invite.code })
    );
    const payload = { userId: 2, username: await nameOf(2), serverId: 1 };
    expect(viaInvite).toEqual([{ event: 'member:joined', payload }]);

    await member.caller.servers.leave({ serverId: 1 });
    await getTestDb()
      .update(servers)
      .set({ discoverable: true })
      .where(eq(servers.id, 1));
    const viaDiscover = await collect(['member:joined', 'user:connected'], () =>
      member.caller.servers.joinDiscover({ serverId: 1 })
    );
    expect(viaDiscover).toEqual([{ event: 'member:joined', payload }]);
  });

  test('a loaded plugin receives member:joined and member:left through ctx.events', async () => {
    const owner = await initTest(1);
    await enablePluginsSetting();
    const invite = await owner.caller.invites.add({ serverId: 1 });
    const member = await initTest(2);

    const id = 'member-events-plugin';
    const cleanup = await writePlugin({
      id,
      entrySource: `
        export const onLoad = (ctx) => {
          globalThis.__memberEvents = [];
          ctx.events.on('member:joined', (p) => { globalThis.__memberEvents.push(['member:joined', p]); });
          ctx.events.on('member:left', (p) => { globalThis.__memberEvents.push(['member:left', p]); });
        };
      `
    });

    try {
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);

      await member.caller.servers.leave({ serverId: 1 });
      await member.caller.servers.joinByInvite({ inviteCode: invite.code });
      await new Promise((r) => setTimeout(r, 0));

      const payload = { userId: 2, username: await nameOf(2), serverId: 1 };
      expect((globalThis as { __memberEvents?: unknown }).__memberEvents).toEqual([
        ['member:left', payload],
        ['member:joined', payload]
      ]);
    } finally {
      delete (globalThis as { __memberEvents?: unknown }).__memberEvents;
      await pluginManager.unload(id);
      await cleanup();
    }
  });
});
