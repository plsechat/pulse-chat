import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import {
  createTestChannel,
  insertMemberUser,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { bridgeLinks } from '../../db/schema';
import { PLUGINS_PATH } from '../../helpers/paths';
import { decryptImportToken } from '../../import/token-crypto';
import { pluginManager } from '../../plugins';
import { BRIDGE_PLUGIN_ID } from '../channels/bridge-_shared';

/**
 * channels.bridge* routes: the server's record of a channel bridge and
 * its hand-off to the bridge plugin. The plugin here is a fixture that
 * registers the same four HTTP routes the real one does and records
 * what the server sent it; the real plugin's own behaviour is covered
 * in its package and by plugins/__tests__/discord-bridge-plugin.test.ts.
 */

type TFixtureCall = { path: string; body: Record<string, unknown> };

type TFixtureState = {
  calls: TFixtureCall[];
  known: boolean;
  configured: boolean;
  upsert: { status: number; body: unknown };
};

declare global {
  // eslint-disable-next-line no-var
  var __bridgeFixture: TFixtureState | undefined;
}

const GUILD = '100000000000000001';
const GENERAL = '200000000000000001';
const RAIDS = '200000000000000002';
const WEBHOOK_TOKEN = 'wh-secret-token';

const freshFixtureState = (): TFixtureState => ({
  calls: [],
  known: false,
  configured: true,
  upsert: { status: 200, body: { webhookId: '910000000000000001', webhookToken: WEBHOOK_TOKEN } }
});

// The entry source is the same for every test on purpose: the module
// is imported once per path and cached, so behaviour is steered
// through globalThis.__bridgeFixture rather than through the file.
const FIXTURE_ENTRY = `
const state = () => globalThis.__bridgeFixture;
export const onLoad = (ctx) => {
  ctx.http.register('channels', (req) => {
    state().calls.push({ path: 'channels', body: req.body });
    if (!state().configured) return { status: 409, body: { error: 'No bot token is configured' } };
    return { status: 200, body: { guilds: [{ id: '${GUILD}', name: 'Night Raiders', iconUrl: null }], channels: req.body.guildId ? [{ id: '${GENERAL}', guildId: '${GUILD}', name: 'general', parentName: null, position: 1 }] : [] } };
  });
  ctx.http.register('links/upsert', (req) => {
    state().calls.push({ path: 'links/upsert', body: req.body });
    if (req.body.webhookId) { state().known = true; return { status: 200, body: { webhookId: req.body.webhookId, webhookToken: req.body.webhookToken ?? null } }; }
    const answer = state().upsert;
    if (answer.status === 200) state().known = true;
    return answer;
  });
  ctx.http.register('links/remove', (req) => {
    state().calls.push({ path: 'links/remove', body: req.body });
    const removed = state().known;
    state().known = false;
    return { status: 200, body: { removed } };
  });
  ctx.http.register('status', (req) => {
    state().calls.push({ path: 'status', body: req.body });
    const links = {};
    for (const id of req.body.channelIds) links[String(id)] = { known: state().known, mirroredToday: 3, lastError: null };
    return { status: 200, body: { configured: state().configured, connected: state().configured, fatal: null, lastError: null, botUser: state().configured ? { id: '9', name: 'pulse-bridge' } : null, links } };
  });
};
export const onUnload = () => {};
`;

/** Write + enable the fixture plugin under the bridge's id; returns the cleanup. */
const loadFixturePlugin = async () => {
  globalThis.__bridgeFixture = freshFixtureState();
  const dir = path.join(PLUGINS_PATH, BRIDGE_PLUGIN_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: BRIDGE_PLUGIN_ID,
      version: '0.0.1',
      pulse: { entry: 'index.js', author: 'test', description: 'bridge fixture', sdk: '^0.2.0' }
    })
  );
  await fs.writeFile(path.join(dir, 'index.js'), FIXTURE_ENTRY);

  await pluginManager.togglePlugin(BRIDGE_PLUGIN_ID, true);
  expect(pluginManager.isPluginLoaded(BRIDGE_PLUGIN_ID)).toBe(true);

  return async () => {
    // toggle(false) unloads AND clears the in-memory enabled flag, so
    // the next test's toggle(true) loads again.
    await pluginManager.togglePlugin(BRIDGE_PLUGIN_ID, false);
    await fs.rm(dir, { recursive: true, force: true });
    globalThis.__bridgeFixture = undefined;
  };
};

const fixture = () => globalThis.__bridgeFixture!;
const fixtureCalls = (route: string) => fixture().calls.filter((c) => c.path === route);

const rowsFor = (channelId: number) =>
  getTestDb().select().from(bridgeLinks).where(eq(bridgeLinks.channelId, channelId));

const linkInput = (channelId: number, remoteChannelId = GENERAL) => ({
  channelId,
  remoteGuildId: GUILD,
  remoteChannelId,
  direction: 'both' as const
});

describe('channels.bridge* — without the plugin', () => {
  test('status says the bridge is unavailable; linking is refused as a precondition', async () => {
    const { caller } = await initTest(1);
    const channelId = await createTestChannel({ serverId: 1, name: 'bridge-me' });

    const status = await caller.channels.bridgeStatus({ channelId });
    expect(status).toMatchObject({ available: false, bridgeable: true, link: null, connected: false });

    await expect(caller.channels.bridgeLink(linkInput(channelId))).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED'
    });
    await expect(caller.channels.bridgeRemoteChannels({})).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED'
    });
    expect(await rowsFor(channelId)).toHaveLength(0);
  });
});

describe('channels.bridge* — with the plugin', () => {
  test('linking creates the row with the token encrypted at rest and never returns it', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'bridge-me' });

    try {
      const view = await caller.channels.bridgeLink(linkInput(channelId));

      expect(view).toMatchObject({
        channelId,
        remoteGuildId: GUILD,
        remoteChannelId: GENERAL,
        webhookId: '910000000000000001',
        direction: 'both',
        createdBy: 1
      });
      expect(JSON.stringify(view)).not.toContain(WEBHOOK_TOKEN);
      expect(JSON.stringify(view)).not.toContain('Ciphertext');

      const [row] = await rowsFor(channelId);
      expect(row!.pluginId).toBe(BRIDGE_PLUGIN_ID);
      expect(row!.webhookTokenCiphertext).not.toBe(WEBHOOK_TOKEN);
      expect(row!.webhookTokenCiphertext).not.toContain(WEBHOOK_TOKEN);
      expect(decryptImportToken(row!.webhookTokenCiphertext!)).toBe(WEBHOOK_TOKEN);

      expect(fixtureCalls('links/upsert')).toEqual([
        {
          path: 'links/upsert',
          body: { channelId, serverId: 1, remoteGuildId: GUILD, remoteChannelId: GENERAL, direction: 'both' }
        }
      ]);

      const status = await caller.channels.bridgeStatus({ channelId });
      expect(status).toMatchObject({
        available: true,
        configured: true,
        connected: true,
        botUser: { id: '9', name: 'pulse-bridge' },
        link: { channelId, webhookId: '910000000000000001' },
        mirroredToday: 3,
        linkError: null
      });
      expect(JSON.stringify(status)).not.toContain(WEBHOOK_TOKEN);
    } finally {
      await cleanup();
    }
  });

  test('an encrypted channel and a voice channel are refused in plain words, before the plugin is asked', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const encrypted = await createTestChannel({ serverId: 1, name: 'secret', e2ee: true });
    const voice = await createTestChannel({ serverId: 1, name: 'voice', type: ChannelType.VOICE });

    try {
      await expect(caller.channels.bridgeLink(linkInput(encrypted))).rejects.toThrow(
        'end-to-end encrypted'
      );
      await expect(caller.channels.bridgeLink(linkInput(voice))).rejects.toThrow(
        'Only text channels'
      );
      expect(fixtureCalls('links/upsert')).toHaveLength(0);
      expect(await rowsFor(encrypted)).toHaveLength(0);

      expect(await caller.channels.bridgeStatus({ channelId: encrypted })).toMatchObject({
        bridgeable: false,
        link: null
      });
    } finally {
      await cleanup();
    }
  });

  test('a channel of another server is NOT_FOUND for every route; a member without MANAGE_CHANNELS is refused', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const other = await insertOtherServer();
    const foreign = await createTestChannel({ serverId: other.id, name: 'theirs' });
    const mine = await createTestChannel({ serverId: 1, name: 'mine' });

    try {
      await expect(caller.channels.bridgeLink(linkInput(foreign))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(caller.channels.bridgeUnlink({ channelId: foreign })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(caller.channels.bridgeStatus({ channelId: foreign })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(fixtureCalls('links/upsert')).toHaveLength(0);

      const member = await insertMemberUser();
      const { caller: memberCaller } = await initTest(member.id);
      await expect(memberCaller.channels.bridgeLink(linkInput(mine))).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(memberCaller.channels.bridgeStatus({ channelId: mine })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(memberCaller.channels.bridgeRemoteChannels({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await cleanup();
    }
  });

  test('inputs are bounded: remote ids must be snowflakes, the direction one of three', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'bounded' });

    try {
      await expect(
        caller.channels.bridgeLink({ ...linkInput(channelId), remoteChannelId: 'https://evil' })
      ).rejects.toThrow();
      await expect(
        caller.channels.bridgeLink({ ...linkInput(channelId), remoteGuildId: '1'.repeat(21) })
      ).rejects.toThrow();
      await expect(
        caller.channels.bridgeLink({ ...linkInput(channelId), direction: 'sideways' as never })
      ).rejects.toThrow();
      await expect(caller.channels.bridgeRemoteChannels({ guildId: 'abc' })).rejects.toThrow();
      expect(fixtureCalls('links/upsert')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('a remote channel already bridged elsewhere is a CONFLICT and no webhook is created', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const first = await createTestChannel({ serverId: 1, name: 'first' });
    const second = await createTestChannel({ serverId: 1, name: 'second' });

    try {
      await caller.channels.bridgeLink(linkInput(first));
      await expect(caller.channels.bridgeLink(linkInput(second))).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(fixtureCalls('links/upsert')).toHaveLength(1);
      expect(await rowsFor(second)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('re-linking to the same remote channel only changes the direction, re-pushing the known webhook with its decrypted token in-process', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'direction' });

    try {
      const created = await caller.channels.bridgeLink(linkInput(channelId));
      const updated = await caller.channels.bridgeLink({ ...linkInput(channelId), direction: 'inbound' });

      expect(updated.id).toBe(created.id);
      expect(updated.direction).toBe('inbound');
      const [row] = await rowsFor(channelId);
      expect(row!.direction).toBe('inbound');

      const pushes = fixtureCalls('links/upsert');
      expect(pushes).toHaveLength(2);
      expect(pushes[1]!.body).toEqual({
        channelId,
        serverId: 1,
        remoteGuildId: GUILD,
        remoteChannelId: GENERAL,
        direction: 'inbound',
        webhookId: '910000000000000001',
        webhookToken: WEBHOOK_TOKEN
      });
      expect(fixtureCalls('links/remove')).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('re-linking to a different remote channel tears the old link down and creates a new webhook', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'move' });

    try {
      const first = await caller.channels.bridgeLink(linkInput(channelId));
      fixture().upsert = { status: 200, body: { webhookId: '910000000000000002', webhookToken: 'second-token' } };
      const second = await caller.channels.bridgeLink(linkInput(channelId, RAIDS));

      expect(second.id).not.toBe(first.id);
      expect(second).toMatchObject({ remoteChannelId: RAIDS, webhookId: '910000000000000002' });
      expect(await rowsFor(channelId)).toHaveLength(1);
      expect(fixtureCalls('links/remove')).toEqual([{ path: 'links/remove', body: { channelId } }]);
      expect(fixtureCalls('links/upsert')[1]!.body).toMatchObject({ remoteChannelId: RAIDS });
      expect(decryptImportToken((await rowsFor(channelId))[0]!.webhookTokenCiphertext!)).toBe('second-token');
    } finally {
      await cleanup();
    }
  });

  test('the plugin refusing (no token, webhook failure) surfaces its message; nothing is stored', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'refused' });

    try {
      fixture().upsert = { status: 502, body: { error: 'Could not create the webhook: Missing Access' } };
      await expect(caller.channels.bridgeLink(linkInput(channelId))).rejects.toThrow('Missing Access');
      expect(await rowsFor(channelId)).toHaveLength(0);

      fixture().upsert = { status: 409, body: { error: 'That remote channel is already bridged to another channel' } };
      await expect(caller.channels.bridgeLink(linkInput(channelId))).rejects.toMatchObject({ code: 'CONFLICT' });

      fixture().configured = false;
      await expect(caller.channels.bridgeRemoteChannels({})).rejects.toThrow('No bot token');
      expect(await caller.channels.bridgeStatus({ channelId })).toMatchObject({
        available: true,
        configured: false,
        connected: false,
        botUser: null
      });
    } finally {
      await cleanup();
    }
  });

  test('unlink removes the row and tells the plugin; a second unlink is a no-op', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'unlink' });

    try {
      await caller.channels.bridgeLink(linkInput(channelId));
      expect(await caller.channels.bridgeUnlink({ channelId })).toEqual({ removed: true });
      expect(await rowsFor(channelId)).toHaveLength(0);
      expect(fixtureCalls('links/remove')).toEqual([{ path: 'links/remove', body: { channelId } }]);

      expect(await caller.channels.bridgeUnlink({ channelId })).toEqual({ removed: false });
      expect(fixtureCalls('links/remove')).toHaveLength(1);
      expect((await caller.channels.bridgeStatus({ channelId })).link).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('status reconciles the two copies: a row the plugin lost is pushed again with its token; a link the plugin kept after an unlink is removed', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'reconcile' });

    try {
      await caller.channels.bridgeLink(linkInput(channelId));

      // The plugin forgot (state file gone).
      fixture().known = false;
      const status = await caller.channels.bridgeStatus({ channelId });
      expect(status.link?.channelId).toBe(channelId);
      const pushes = fixtureCalls('links/upsert');
      expect(pushes[pushes.length - 1]!.body).toMatchObject({
        channelId,
        webhookId: '910000000000000001',
        webhookToken: WEBHOOK_TOKEN
      });
      expect(fixture().known).toBe(true);

      // The server dropped the row while the plugin was down.
      await getTestDb().delete(bridgeLinks).where(eq(bridgeLinks.channelId, channelId));
      const after = await caller.channels.bridgeStatus({ channelId });
      expect(after.link).toBeNull();
      expect(after.mirroredToday).toBe(0);
      expect(fixtureCalls('links/remove')).toEqual([{ path: 'links/remove', body: { channelId } }]);
      expect(fixture().known).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test('the remote picker proxies the plugin: guilds without a guild id, channels with one', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      expect(await caller.channels.bridgeRemoteChannels({})).toEqual({
        guilds: [{ id: GUILD, name: 'Night Raiders', iconUrl: null }],
        channels: []
      });
      expect((await caller.channels.bridgeRemoteChannels({ guildId: GUILD })).channels).toEqual([
        { id: GENERAL, guildId: GUILD, name: 'general', parentName: null, position: 1 }
      ]);
      expect(fixtureCalls('channels').map((c) => c.body)).toEqual([{}, { guildId: GUILD }]);
    } finally {
      await cleanup();
    }
  });

  test('deleting the channel cascades the link row', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const channelId = await createTestChannel({ serverId: 1, name: 'cascade' });

    try {
      await caller.channels.bridgeLink(linkInput(channelId));
      await caller.channels.delete({ channelId });
      expect(await rowsFor(channelId)).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
