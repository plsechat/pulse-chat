import { ServerEvents } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import {
  createEmptyTextChannel,
  insertMemberUser,
  insertOtherServer
} from '../../__tests__/fixtures';
import { firstSubscriptionEvent, initTest, waitUntil } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { pubsub } from '../../utils/pubsub';
import { messages, servers } from '../../db/schema';
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

// Throwaway plugin whose one command `deploy` acts through sub-commands
// (SDK 0.4.0): `ship <target>` with choices, `halt`, and a hidden
// `report <channel-id>`. It has no arguments of its own, so `/deploy`
// alone is answered with usage. `onLoad` records what each call got.
const writeSubcommandPlugin = async (id: string, subcommandSource?: string) => {
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
        logo: 'https://example.com/deploy.png'
      }
    })
  );
  await fs.writeFile(
    path.join(dir, 'index.js'),
    `export const onLoad = (ctx) => {
      ctx.commands.register({
        name: 'deploy',
        description: 'Ship a build',
        subcommands: ${
          subcommandSource ??
          `[
          { name: 'ship', description: 'Ship to a target', args: [
            { name: 'target', type: 'string', required: true, choices: [{ value: 'prod', label: 'Production' }, { value: 'stage' }] },
            { name: 'token', type: 'string', sensitive: true }
          ] },
          { name: 'halt', description: 'Stop the rollout' },
          { name: 'report', hidden: true, args: [{ name: 'channel-id', type: 'number' }] }
        ]`
        },
        executes: async (invoker, args) => ({
          subcommand: invoker.subcommand ?? null,
          // A reply is the plugin's own words: it must not echo a secret.
          args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k, k === 'token' ? '(kept)' : v]))
        })
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

  test('plugins.get lists each plugin\'s commands even while the active server has plugins off', async () => {
    const { caller } = await initTest(1);
    // The instance panel is opened from whatever community is active;
    // its Plugins switch gates running commands there, never what the
    // instance owner gets to see about a plugin.
    await setServerPlugins(1, false);
    const id = 'instance-listing';
    const cleanup = await writeSubcommandPlugin(id);

    try {
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);

      await expect(caller.plugins.getCommands({ pluginId: id })).rejects.toThrow(
        'Plugin commands are not enabled on this server'
      );

      const { plugins } = await caller.plugins.get();
      const listed = plugins.find((p) => p.id === id);
      expect(listed?.commands.map((c) => c.name)).toEqual(['deploy']);
      // The hidden sub-command stays hidden here too.
      expect(listed?.commands[0]?.subcommands?.map((s) => s.name)).toEqual(['ship', 'halt']);
      // A plugin that is not loaded has nothing registered.
      await pluginManager.unload(id);
      const after = (await caller.plugins.get()).plugins.find((p) => p.id === id);
      expect(after?.commands).toEqual([]);
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
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

  test('onCommandsChange stays live while plugins are off: an empty map then, the list once the switch flips', async () => {
    const member = await insertMemberUser();
    const { caller } = await initTest(member.id);
    const { caller: owner } = await initTest(1);
    await setServerPlugins(1, false);

    // A registry change while the switch is off reaches the member as nothing.
    const whileOff = await firstSubscriptionEvent(caller, 'plugins', 'onCommandsChange', () =>
      pubsub.publishFor([member.id], ServerEvents.PLUGIN_COMMANDS_CHANGE, pluginManager.getCommands())
    );
    expect(whileOff).toEqual({});

    // The owner switching plugins on publishes the list to the members.
    const onFlip = await firstSubscriptionEvent(caller, 'plugins', 'onCommandsChange', () =>
      owner.others.updateSettings({ serverId: 1, enablePlugins: true })
    );
    expect(onFlip).toEqual(pluginManager.getCommands());
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

describe('plugins router — sub-commands (SDK 0.4.0)', () => {
  test('the command list carries visible sub-commands, choices and the logo; hidden ones stay out', async () => {
    const { caller } = await initTest(1);
    await setServerPlugins(1, true);
    const id = 'subcommands-listing';
    const cleanup = await writeSubcommandPlugin(id);

    try {
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(true);

      const listed = await caller.plugins.getCommands({ pluginId: id });
      expect(listed[id]).toEqual([
        {
          pluginId: id,
          name: 'deploy',
          description: 'Ship a build',
          logo: 'https://example.com/deploy.png',
          subcommands: [
            {
              name: 'ship',
              description: 'Ship to a target',
              args: [
                {
                  name: 'target',
                  type: 'string',
                  required: true,
                  choices: [{ value: 'prod', label: 'Production' }, { value: 'stage' }]
                },
                { name: 'token', type: 'string', sensitive: true }
              ]
            },
            { name: 'halt', description: 'Stop the rollout' }
          ]
        }
      ]);

      // The hidden verb is still callable, through the route as well.
      expect(pluginManager.hasCommand(id, 'deploy', 'report')).toBe(true);
      expect(pluginManager.hasCommand(id, 'deploy', 'rewind')).toBe(false);
      expect(pluginManager.hasCommand(id, 'deploy')).toBe(true);
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });

  test('executeCommand runs a sub-command with its arguments; an unknown verb is BAD_REQUEST; bare /deploy answers with usage', async () => {
    const { caller } = await initTest(1);
    await setServerPlugins(1, true);
    const id = 'subcommands-execute';
    const cleanup = await writeSubcommandPlugin(id);

    try {
      await pluginManager.togglePlugin(id, true);

      expect(
        await caller.plugins.executeCommand({
          pluginId: id,
          commandName: 'deploy',
          subcommand: 'ship',
          args: { target: 'prod', token: 'hunter2' }
        })
      ).toEqual({ subcommand: 'ship', args: { target: 'prod', token: '(kept)' } });

      expect(
        await caller.plugins.executeCommand({
          pluginId: id,
          commandName: 'deploy',
          subcommand: 'report',
          args: { 'channel-id': 4 }
        })
      ).toEqual({ subcommand: 'report', args: { 'channel-id': 4 } });

      await expect(
        caller.plugins.executeCommand({
          pluginId: id,
          commandName: 'deploy',
          subcommand: 'rewind'
        })
      ).rejects.toThrow('has no sub-command "rewind"');

      // No sub-command and no arguments of its own: the usage, not a run.
      expect(
        await caller.plugins.executeCommand({ pluginId: id, commandName: 'deploy' })
      ).toBe(
        [
          'Usage: /deploy <ship | halt>',
          '/deploy ship <target> [token] — Ship to a target',
          '/deploy halt — Stop the rollout'
        ].join('\n')
      );

      // The sensitive argument of the sub-command is redacted in the log.
      const executing = pluginManager
        .getLogs(id)
        .filter((l) => l.message.includes("Executing command 'deploy ship'"));
      expect(executing.length).toBe(1);
      expect(executing[0]!.message).not.toContain('hunter2');
      expect(executing[0]!.message).toContain('[redacted]');
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });

  test('a command typed into a channel resolves its sub-command; the stored element names it', async () => {
    const { caller } = await initTest(1);
    await setServerPlugins(1, true);
    const id = 'subcommands-typed';
    const cleanup = await writeSubcommandPlugin(id);
    const channel = await createEmptyTextChannel('deploys');
    const tdb = getTestDb();

    try {
      await pluginManager.togglePlugin(id, true);

      const messageId = await caller.messages.send({ channelId: channel.id, content: '/deploy ship stage s3cret' });
      await waitUntil(async () => {
        const [row] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, messageId));
        return row?.content?.includes("data-status='completed'") ?? false;
      });
      const [row] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, messageId));
      expect(row!.content).toContain('data-command="deploy" data-subcommand="ship"');
      expect(row!.content).toContain('{"name":"target","value":"stage","status":"completed"},{"name":"token","value":"****","status":"completed"}');
      expect(row!.content).toContain('"subcommand": "ship"');
      expect(row!.content).toContain('"target": "stage"');
      expect(row!.content).not.toContain('s3cret');

      // Bare `/deploy`: the usage is the reply, and the command completes.
      const bareId = await caller.messages.send({ channelId: channel.id, content: '/deploy' });
      await waitUntil(async () => {
        const [bare] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, bareId));
        return bare?.content?.includes("data-status='completed'") ?? false;
      });
      const [bare] = await tdb.select({ content: messages.content }).from(messages).where(eq(messages.id, bareId));
      expect(bare!.content).toContain('Usage: /deploy <ship | halt>');
      expect(bare!.content).not.toContain('data-subcommand');
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });

  test('a declaration out of bounds is the plugin load error', async () => {
    await initTest(1);
    await setServerPlugins(1, true);
    const id = 'subcommands-bounds';
    const tooMany = JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ name: `s${i}` })));
    const cleanup = await writeSubcommandPlugin(id, tooMany);

    try {
      await pluginManager.togglePlugin(id, true);
      expect(pluginManager.isPluginLoaded(id)).toBe(false);
      expect(pluginManager.hasCommand(id, 'deploy')).toBe(false);
      const info = await pluginManager.getPluginInfo(id);
      expect(info.loadError).toBe(
        "Command 'deploy' declares 21 sub-commands; at most 20 are allowed"
      );
    } finally {
      await pluginManager.unload(id);
      await cleanup();
    }
  });
});
