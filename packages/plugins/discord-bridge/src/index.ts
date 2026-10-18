import type { PluginContext, UnloadPluginContext } from '@pulse/plugin-sdk';
import { Bridge } from './bridge';
import { createFileStorage } from './store';

/**
 * Plugin entry. Settings are read through the SDK's settings store.
 * The bot token is a `secret` setting: the server keeps it encrypted
 * under the instance's file-signing secret, no route returns it (the
 * settings panel only says whether one is set), and `settings.get` is
 * the one place its plaintext comes back — here, to dial the gateway.
 * A token saved before SDK 0.3 (stored in the clear) is encrypted by
 * the server on the first load after the upgrade.
 */

const settingDefinitions = [
  {
    key: 'botToken',
    name: 'Bot token',
    description:
      'Token of the bot application that sits in the remote server(s). Needs the Server Members and Message Content intents switched on, and Manage Webhooks, Manage Messages, Manage Threads, Manage Events and Add Reactions where it is used. Stored encrypted and never shown again; picked up within 15 seconds of a change.',
    type: 'secret',
    defaultValue: ''
  },
  {
    key: 'publicUrl',
    name: 'Public address of this instance',
    description:
      'For example https://chat.example.com. Used to turn member avatars and attachment links into addresses the other side can open. Leave empty to mirror without avatars.',
    type: 'string',
    defaultValue: ''
  }
] as const;

const SETTINGS_POLL_MS = 15_000;

let bridge: Bridge | null = null;
let poll: ReturnType<typeof setInterval> | null = null;

const onLoad = async (ctx: PluginContext) => {
  const settings = await ctx.settings.register(settingDefinitions);
  const text = (key: 'botToken' | 'publicUrl') => {
    const value = settings.get(key);
    return typeof value === 'string' ? value.trim() : '';
  };

  bridge = new Bridge({
    ctx,
    settings: {
      botToken: () => text('botToken'),
      publicUrl: () => text('publicUrl')
    },
    storage: createFileStorage(ctx.path)
  });

  await bridge.start();

  poll = setInterval(() => bridge?.checkSettings(), SETTINGS_POLL_MS);
  poll.unref?.();
};

const onUnload = async (ctx: UnloadPluginContext) => {
  if (poll) {
    clearInterval(poll);
    poll = null;
  }

  const running = bridge;
  bridge = null;

  if (running) {
    await running.stop();
    ctx.log('Bridge stopped');
  }
};

export { onLoad, onUnload };
