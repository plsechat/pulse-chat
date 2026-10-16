import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import { insertMemberUser, insertOtherServer } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { servers } from '../../db/schema';
import { PLUGINS_PATH } from '../../helpers/paths';
import { pluginManager } from '../../plugins';

/**
 * The plugin manager is one singleton for the whole instance, so every
 * plugin management route is instance-owner-only (seeded user 1 owns
 * the bootstrap server). The one per-server lever is
 * `servers.enablePlugins`, which gates command *execution* from that
 * server — never loading or unloading.
 */

const setServerPlugins = async (serverId: number, enablePlugins: boolean) => {
  await getTestDb()
    .update(servers)
    .set({ enablePlugins })
    .where(eq(servers.id, serverId));
};

/** A user who owns their OWN server but is not the instance owner. */
const initOtherServerOwner = async () => {
  const owner = await insertMemberUser();
  const other = await insertOtherServer();
  await getTestDb()
    .update(servers)
    .set({ ownerId: owner.id })
    .where(eq(servers.id, other.id));
  return initTest(owner.id);
};

// Throwaway plugin under PLUGINS_PATH that registers one command with a
// sensitive argument. Ids are unique per test: the manager caches
// enabled-state in memory across the per-test TRUNCATE.
const writeCommandPlugin = async (id: string) => {
  const dir = path.join(PLUGINS_PATH, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: id,
      version: '1.0.0',
      pulse: { entry: 'index.js', author: 'test', description: 'test plugin' }
    })
  );
  await fs.writeFile(
    path.join(dir, 'index.js'),
    `export const onLoad = (ctx) => {
      ctx.commands.register({
        name: 'login',
        args: [
          { name: 'user', type: 'string' },
          { name: 'password', type: 'string', sensitive: true }
        ],
        executes: async (_ctx, args) => ({ ok: true, user: args.user })
      });
    };`
  );

  return () => fs.rm(dir, { recursive: true, force: true });
};

describe('plugins router — instance-owner surface', () => {
  test('a non-instance-owner server owner cannot toggle a plugin', async () => {
    const { caller } = await initOtherServerOwner();

    await expect(
      caller.plugins.toggle({ pluginId: 'anything', enabled: true })
    ).rejects.toThrow('Only the instance owner');
  });

  test('a non-instance-owner server owner cannot list, read logs/settings or update settings', async () => {
    const { caller } = await initOtherServerOwner();

    await expect(caller.plugins.get()).rejects.toThrow('Only the instance owner');
    await expect(
      caller.plugins.getLogs({ pluginId: 'anything' })
    ).rejects.toThrow('Only the instance owner');
    await expect(
      caller.plugins.getSettings({ pluginId: 'anything' })
    ).rejects.toThrow('Only the instance owner');
    await expect(
      caller.plugins.updateSetting({ pluginId: 'anything', key: 'k', value: 1 })
    ).rejects.toThrow('Only the instance owner');
  });

  test('a plain user cannot subscribe to the plugin log stream', async () => {
    const member = await insertMemberUser();
    const { caller } = await initTest(member.id);

    await expect(caller.plugins.onLog()).rejects.toThrow(
      'Only the instance owner'
    );
  });

  test('the instance owner can list plugins and subscribe to logs', async () => {
    const { caller } = await initTest(1);

    const { plugins } = await caller.plugins.get();
    expect(Array.isArray(plugins)).toBe(true);

    const stream = await caller.plugins.onLog();
    expect(typeof stream.subscribe).toBe('function');
  });

  test('plugin ids are bounded', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.plugins.getLogs({ pluginId: 'x'.repeat(65) })
    ).rejects.toThrow();
    await expect(
      caller.plugins.toggle({ pluginId: '', enabled: true })
    ).rejects.toThrow();
  });
});

describe('plugins router — per-server command execution', () => {
  test('executeCommand is FORBIDDEN on a server with enablePlugins=false', async () => {
    // User 1 owns server 1 (holds EXECUTE_PLUGIN_COMMANDS) — the server
    // flag alone must block the call.
    const { caller } = await initTest(1);
    await setServerPlugins(1, false);

    await expect(
      caller.plugins.executeCommand({ pluginId: 'p', commandName: 'c' })
    ).rejects.toThrow('Plugin commands are not enabled on this server');
  });

  test('executeCommand passes the server gate when enablePlugins=true (unknown command → BAD_REQUEST)', async () => {
    const { caller } = await initTest(1);
    await setServerPlugins(1, true);

    await expect(
      caller.plugins.executeCommand({ pluginId: 'p', commandName: 'nope' })
    ).rejects.toThrow('not found for plugin');
  });

  test('getCommands is FORBIDDEN when the active server has plugins disabled, {} when enabled', async () => {
    const member = await insertMemberUser();
    const { caller } = await initTest(member.id);
    await setServerPlugins(1, false);

    await expect(caller.plugins.getCommands({})).rejects.toThrow(
      'Plugin commands are not enabled on this server'
    );

    await setServerPlugins(1, true);
    const commands = await caller.plugins.getCommands({ pluginId: 'unknown' });
    expect(commands).toEqual({});
  });

  test('onCommandsChange yields a silent stream on a server with plugins disabled', async () => {
    const member = await insertMemberUser();
    const { caller } = await initTest(member.id);
    await setServerPlugins(1, false);

    const stream = await caller.plugins.onCommandsChange();
    expect(typeof stream.subscribe).toBe('function');
  });

  test('command args are bounded: too many keys, oversize values, nested objects', async () => {
    const { caller } = await initTest(1);
    await setServerPlugins(1, true);

    const tooManyKeys = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`k${i}`, 'v'])
    );
    await expect(
      caller.plugins.executeCommand({
        pluginId: 'p',
        commandName: 'c',
        args: tooManyKeys
      })
    ).rejects.toThrow();

    await expect(
      caller.plugins.executeCommand({
        pluginId: 'p',
        commandName: 'c',
        args: { big: 'x'.repeat(4097) }
      })
    ).rejects.toThrow();

    await expect(
      caller.plugins.executeCommand({
        pluginId: 'p',
        commandName: 'c',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        args: { nested: { deep: true } } as any
      })
    ).rejects.toThrow();
  });

  test('updateSetting values are bounded', async () => {
    const { caller } = await initTest(1);

    await expect(
      caller.plugins.updateSetting({
        pluginId: 'p',
        key: 'k'.repeat(65),
        value: 'v'
      })
    ).rejects.toThrow();
    await expect(
      caller.plugins.updateSetting({
        pluginId: 'p',
        key: 'k',
        value: 'v'.repeat(4097)
      })
    ).rejects.toThrow();
  });

  test('sensitive command arguments are redacted in the plugin log and the activity log', async () => {
    await initTest(1);
    // Instance-level enablement lives on the bootstrap server row; the
    // per-server flag only gates execution.
    await setServerPlugins(1, true);

    const id = 'redact-sensitive-args';
    const cleanup = await writeCommandPlugin(id);

    try {
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.hasCommand(id, 'login')).toBe(true);

      const redacted = pluginManager.redactCommandArgs(id, 'login', {
        user: 'alice',
        password: 'hunter2'
      });
      expect(redacted).toEqual({ user: 'alice', password: '[redacted]' });

      await pluginManager.executeCommand(
        id,
        'login',
        { userId: 1 },
        { user: 'alice', password: 'hunter2' }
      );

      const logs = await pluginManager.getLogs(id);
      const executing = logs.filter((l) =>
        l.message.includes("Executing command 'login'")
      );
      expect(executing.length).toBeGreaterThanOrEqual(1);
      for (const entry of executing) {
        expect(entry.message).not.toContain('hunter2');
        expect(entry.message).toContain('[redacted]');
      }
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });
});
