import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import path from 'path';
import { createTestChannel } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { PLUGINS_PATH } from '../../helpers/paths';
import { pluginManager } from '..';
import { eventBus } from '../event-bus';
import { pluginHttp } from '../http';

/**
 * The official bridge plugin, built from packages/plugins/discord-bridge
 * and loaded through the real loader the way the image ships it:
 * manifest validated, SDK range accepted, capability declared, settings
 * and HTTP routes registered — and, with no bot token set, nothing
 * dialled. The channel routes reach it in-process.
 */

const PLUGIN_ID = 'discord-bridge';
const PACKAGE_DIR = path.resolve(process.cwd(), '..', '..', 'packages', 'plugins', PLUGIN_ID);

/** Build the real package into PLUGINS_PATH exactly as the Dockerfile does. */
const installRealPlugin = async () => {
  const dir = path.join(PLUGINS_PATH, PLUGIN_ID);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });

  const built = await Bun.build({
    entrypoints: [path.join(PACKAGE_DIR, 'src', 'index.ts')],
    outdir: path.join(dir, 'dist'),
    target: 'bun',
    format: 'esm'
  });
  expect(built.success).toBe(true);

  await fs.copyFile(path.join(PACKAGE_DIR, 'package.json'), path.join(dir, 'package.json'));

  return async () => {
    await pluginManager.togglePlugin(PLUGIN_ID, false);
    await fs.rm(dir, { recursive: true, force: true });
  };
};

describe('discord-bridge plugin through the real loader', () => {
  test('loads with its manifest, registers settings, routes and handlers, stays idle without a token, unloads clean', async () => {
    const { caller } = await initTest(1);
    const cleanup = await installRealPlugin();

    try {
      const info = await pluginManager.getPluginInfo(PLUGIN_ID);
      expect(info.capabilities).toEqual(['moderate-messages']);
      expect(info.loadError).toBeUndefined();
      expect(info.enabled).toBe(false);

      await pluginManager.togglePlugin(PLUGIN_ID, true);
      expect(pluginManager.isPluginLoaded(PLUGIN_ID)).toBe(true);
      expect((await pluginManager.getPluginInfo(PLUGIN_ID)).loadError).toBeUndefined();
      expect(pluginManager.hasCapability(PLUGIN_ID, 'moderate-messages')).toBe(true);

      const settings = await pluginManager.getPluginSettings(PLUGIN_ID);
      expect(settings.definitions.map((d) => d.key)).toEqual(['botToken', 'publicUrl']);
      // The bot token is a secret: the route says whether one is set, never what.
      expect(settings.definitions.find((d) => d.key === 'botToken')?.type).toBe('secret');
      expect(settings.values).toEqual({ botToken: { set: false }, publicUrl: '' });
      expect(typeof settings.httpSecret).toBe('string');

      expect(pluginHttp.routeCount(PLUGIN_ID)).toBe(8);
      for (const event of ['message:created', 'message:updated', 'message:deleted', 'message:reaction', 'thread:created', 'event:created'] as const) {
        expect(eventBus.getPluginHandlersCount(PLUGIN_ID, event)).toBe(1);
      }
      expect(pluginManager.getLogs(PLUGIN_ID).some((l) => l.message.includes('No bot token'))).toBe(true);

      // The channel routes reach the running plugin in-process.
      const channelId = await createTestChannel({ serverId: 1, name: 'real-bridge' });
      const status = await caller.channels.bridgeStatus({ channelId });
      expect(status).toMatchObject({
        available: true,
        bridgeable: true,
        configured: false,
        connected: false,
        botUser: null,
        link: null,
        mirroredToday: 0,
        serverLink: null
      });
      expect(await caller.servers.bridgeStatus()).toMatchObject({
        available: true,
        configured: false,
        link: null,
        counts: { paired: 0, excluded: 0, manual: 0 },
        sync: { running: false, last: null }
      });
      await expect(
        caller.servers.bridgeLink({ remoteGuildId: '100000000000000001', mode: 'match' })
      ).rejects.toThrow('No bot token is configured');
      await expect(
        caller.channels.bridgeLink({
          channelId,
          remoteGuildId: '100000000000000001',
          remoteChannelId: '200000000000000001',
          direction: 'both'
        })
      ).rejects.toThrow('No bot token is configured');
      await expect(caller.channels.bridgeRemoteChannels({})).rejects.toThrow('No bot token is configured');

      // A user message in an unlinked channel is a no-op for the bridge
      // (no token, no link): the handler runs and nothing explodes.
      await eventBus.emit('message:created', { messageId: 1, channelId, userId: 1, content: 'hi' });
      expect(pluginManager.getLogs(PLUGIN_ID).filter((l) => l.type === 'error')).toEqual([]);

      await pluginManager.togglePlugin(PLUGIN_ID, false);
      expect(pluginManager.isPluginLoaded(PLUGIN_ID)).toBe(false);
      expect(pluginHttp.routeCount(PLUGIN_ID)).toBe(0);
      expect(eventBus.getPluginHandlersCount(PLUGIN_ID, 'message:created')).toBe(0);
      expect((await caller.channels.bridgeStatus({ channelId })).available).toBe(false);
    } finally {
      await cleanup();
    }
  });
});
