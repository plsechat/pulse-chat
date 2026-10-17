import type { PluginContext, UnloadPluginContext } from '@pulse/plugin-sdk';
import { Bridge } from './bridge';
import { createFileStorage } from './store';

/**
 * Plugin entry. Settings are read through the SDK's settings store,
 * which keeps them as plain JSON in the server's plugin_data table —
 * the bot token included. The instance owner is the only one who can
 * read them back (the plugin settings route), but anyone with the
 * database has them; the README says so in plain words.
 */

const settingDefinitions = [
  {
    key: 'botToken',
    name: 'Bot token',
    description:
      'Token of the bot application that sits in the remote server(s). Needs the Server Members and Message Content intents switched on, and Manage Webhooks, Manage Messages, Manage Threads, Manage Events and Add Reactions where it is used. Picked up within 15 seconds of a change.',
    type: 'string',
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
