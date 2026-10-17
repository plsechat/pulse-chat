import { ChannelType } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import fs from 'node:fs/promises';
import path from 'path';
import {
  createTestCategory,
  createTestChannel,
  insertMemberUser,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  bridgeLinks,
  bridgeServerLinks,
  categories,
  channels
} from '../../db/schema';
import { PLUGINS_PATH } from '../../helpers/paths';
import { decryptImportToken } from '../../import/token-crypto';
import { pluginManager } from '../../plugins';
import { pluginHttp } from '../../plugins/http';
import { BRIDGE_PLUGIN_ID } from '../channels/bridge-_shared';
import {
  awaitServerBridgeSyncs,
  bridgeSyncTick,
  resetServerBridgeSyncState,
  syncServerBridge
} from '../servers/bridge-sync';

/**
 * servers.bridge* and the whole-server sync behind them, against a
 * fixture plugin that answers every route the real one registers from a
 * steerable in-memory remote server (globalThis.__bridgeServerFixture):
 * linking, pairing by name under each mode, channels created on either
 * side (with their categories), the channel-create hooks, the once-a-
 * minute tick, per-channel exclusion, stale pairs, reconcile and unlink.
 * The real plugin's behaviour is covered in its own package.
 *
 * The seed gives server 1 the categories "Text Channels" / "Voice
 * Channels" and the channels "General" (text) and "Voice" (voice); the
 * fixture guild has general, raids, news (text), Voice (voice) and a
 * forum.
 */

type TFixtureCall = { path: string; body: Record<string, unknown> };

type TFixtureRemoteChannel = {
  id: string;
  guildId: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
  position: number;
};

type TFixtureState = {
  calls: TFixtureCall[];
  configured: boolean;
  guilds: { id: string; name: string; iconUrl: null }[];
  channels: TFixtureRemoteChannel[];
  categories: { id: string; guildId: string; name: string }[];
  skipped: { id: string; name: string; reason: string }[];
  links: Record<
    string,
    { serverId: number; remoteChannelId: string; webhookId: string }
  >;
  serverLinks: Record<string, Record<string, unknown>>;
  syncRequested: Record<string, number>;
  nextId: number;
  failCreate: string | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __bridgeServerFixture: TFixtureState | undefined;
}

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const CHAT_CATEGORY = '200000000000000009';
const GENERAL = '200000000000000001';
const RAIDS = '200000000000000002';
const NEWS = '200000000000000004';

const freshFixtureState = (): TFixtureState => ({
  calls: [],
  configured: true,
  guilds: [
    { id: GUILD, name: 'Night Raiders', iconUrl: null },
    { id: OTHER_GUILD, name: 'Second Guild', iconUrl: null }
  ],
  channels: [
    {
      id: GENERAL,
      guildId: GUILD,
      name: 'general',
      parentId: CHAT_CATEGORY,
      parentName: 'Chat',
      position: 1
    },
    {
      id: RAIDS,
      guildId: GUILD,
      name: 'raids',
      parentId: CHAT_CATEGORY,
      parentName: 'Chat',
      position: 2
    },
    {
      id: NEWS,
      guildId: GUILD,
      name: 'news',
      parentId: null,
      parentName: null,
      position: 3
    }
  ],
  categories: [{ id: CHAT_CATEGORY, guildId: GUILD, name: 'Chat' }],
  skipped: [
    { id: '200000000000000003', name: 'Voice', reason: 'voice channel' },
    { id: '200000000000000005', name: 'forum', reason: 'forum' }
  ],
  links: {},
  serverLinks: {},
  syncRequested: {},
  nextId: 1,
  failCreate: null
});

// One module per path, cached by the runtime: behaviour is steered
// through the global state, never by rewriting the file.
const FIXTURE_ENTRY = `
const state = () => globalThis.__bridgeServerFixture;
const record = (path, body) => state().calls.push({ path, body });
const nextId = (prefix) => prefix + String(state().nextId++).padStart(3, '0');
let actions;
export const onLoad = (ctx) => {
  actions = ctx.actions;
  ctx.http.register('channels', (req) => {
    record('channels', req.body);
    const s = state();
    if (!s.configured) return { status: 409, body: { error: 'No bot token is configured' } };
    const guildId = req.body.guildId;
    if (!guildId) return { status: 200, body: { guilds: s.guilds, channels: [] } };
    return {
      status: 200,
      body: {
        guilds: s.guilds,
        channels: s.channels.filter((c) => c.guildId === guildId),
        categories: s.categories.filter((c) => c.guildId === guildId).map(({ id, name }) => ({ id, name })),
        skipped: s.skipped
      }
    };
  });
  ctx.http.register('remote/create-channel', (req) => {
    record('remote/create-channel', req.body);
    const s = state();
    if (s.failCreate) return { status: 502, body: { error: s.failCreate } };
    let parent = null;
    if (req.body.categoryName) {
      parent = s.categories.find((c) => c.guildId === req.body.guildId && c.name.toLowerCase() === req.body.categoryName.toLowerCase()) ?? null;
      if (!parent) {
        parent = { id: nextId('40000000000000'), guildId: req.body.guildId, name: req.body.categoryName };
        s.categories.push(parent);
      }
    }
    const created = { id: nextId('30000000000000'), guildId: req.body.guildId, name: req.body.name, parentId: parent ? parent.id : null, parentName: parent ? parent.name : null, position: 50 + s.channels.length };
    s.channels.push(created);
    return { status: 200, body: { id: created.id, name: created.name, parentId: created.parentId, parentName: created.parentName } };
  });
  ctx.http.register('links/upsert', (req) => {
    record('links/upsert', req.body);
    const s = state();
    for (const [channelId, link] of Object.entries(s.links)) {
      if (link.remoteChannelId === req.body.remoteChannelId && Number(channelId) !== req.body.channelId) {
        return { status: 409, body: { error: 'That remote channel is already bridged to another channel' } };
      }
    }
    if (req.body.webhookId) {
      s.links[String(req.body.channelId)] = { serverId: req.body.serverId, remoteChannelId: req.body.remoteChannelId, webhookId: req.body.webhookId };
      return { status: 200, body: { webhookId: req.body.webhookId, webhookToken: req.body.webhookToken ?? null } };
    }
    if (!s.configured) return { status: 409, body: { error: 'No bot token is configured' } };
    const webhookId = nextId('91000000000000');
    s.links[String(req.body.channelId)] = { serverId: req.body.serverId, remoteChannelId: req.body.remoteChannelId, webhookId };
    return { status: 200, body: { webhookId, webhookToken: 'tok-' + webhookId } };
  });
  ctx.http.register('links/remove', (req) => {
    record('links/remove', req.body);
    const removed = Boolean(state().links[String(req.body.channelId)]);
    delete state().links[String(req.body.channelId)];
    return { status: 200, body: { removed } };
  });
  ctx.http.register('links/remove-many', (req) => {
    record('links/remove-many', req.body);
    let removed = 0;
    for (const id of req.body.channelIds) { if (state().links[String(id)]) removed++; delete state().links[String(id)]; }
    return { status: 200, body: { removed } };
  });
  ctx.http.register('server-links/upsert', (req) => {
    record('server-links/upsert', req.body);
    state().serverLinks[String(req.body.serverId)] = req.body;
    return { status: 200, body: { ok: true } };
  });
  ctx.http.register('server-links/remove', (req) => {
    record('server-links/remove', req.body);
    const removed = Boolean(state().serverLinks[String(req.body.serverId)]);
    delete state().serverLinks[String(req.body.serverId)];
    return { status: 200, body: { removed } };
  });
  ctx.http.register('status', (req) => {
    record('status', req.body);
    const s = state();
    const links = {};
    const ids = new Set(req.body.channelIds ?? []);
    for (const [channelId, link] of Object.entries(s.links)) if ((req.body.serverIds ?? []).includes(link.serverId)) ids.add(Number(channelId));
    for (const id of ids) links[String(id)] = { known: Boolean(s.links[String(id)]), mirroredToday: 0, lastError: null };
    const guilds = {};
    for (const id of req.body.guildIds ?? []) { const g = s.guilds.find((x) => x.id === id); if (g) guilds[id] = { name: g.name }; }
    const syncRequested = {};
    for (const id of req.body.serverIds ?? []) syncRequested[String(id)] = s.syncRequested[String(id)] ?? 0;
    return { status: 200, body: { configured: s.configured, connected: s.configured, fatal: null, lastError: null, botUser: s.configured ? { id: '9', name: 'pulse-bridge' } : null, links, guilds, syncRequested } };
  });
  // Test-only: the plugin creating a local channel through the SDK.
  ctx.http.register('test/create-local', async (req) => {
    const created = await actions.channels.create({ serverId: req.body.serverId, name: req.body.name, type: 'TEXT' });
    return { status: 200, body: { id: created.id } };
  });
};
export const onUnload = () => {};
`;

const FIXTURE_FILE = `index-${process.pid}-${Date.now()}.js`;

const loadFixturePlugin = async () => {
  globalThis.__bridgeServerFixture = freshFixtureState();
  resetServerBridgeSyncState();
  const dir = path.join(PLUGINS_PATH, BRIDGE_PLUGIN_ID);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: BRIDGE_PLUGIN_ID,
      version: '0.0.2',
      // Unique per process: the runtime caches modules by path, and the
      // route suite stages its own fixture under the same plugin id.
      pulse: {
        entry: FIXTURE_FILE,
        author: 'test',
        description: 'bridge fixture',
        sdk: '^0.2.0'
      }
    })
  );
  await fs.writeFile(path.join(dir, FIXTURE_FILE), FIXTURE_ENTRY);

  // Another file may have left the real plugin (same id) loaded in the
  // process-wide manager; a toggle-on would then be a no-op and the
  // fixture never executes. Unload first so this file's copy is the one
  // that runs.
  if (pluginManager.isPluginLoaded(BRIDGE_PLUGIN_ID)) {
    await pluginManager.togglePlugin(BRIDGE_PLUGIN_ID, false);
  }
  await pluginManager.togglePlugin(BRIDGE_PLUGIN_ID, true);
  expect(pluginManager.isPluginLoaded(BRIDGE_PLUGIN_ID)).toBe(true);

  return async () => {
    await awaitServerBridgeSyncs();
    await pluginManager.togglePlugin(BRIDGE_PLUGIN_ID, false);
    await fs.rm(dir, { recursive: true, force: true });
    globalThis.__bridgeServerFixture = undefined;
    resetServerBridgeSyncState();
  };
};

const fixture = () => globalThis.__bridgeServerFixture!;
const fixtureCalls = (route: string) =>
  fixture().calls.filter((c) => c.path === route);

const linkRows = () =>
  getTestDb().select().from(bridgeLinks).orderBy(bridgeLinks.channelId);
const serverLinkRows = () => getTestDb().select().from(bridgeServerLinks);
const channelNames = async (serverId = 1) =>
  (
    await getTestDb()
      .select({ name: channels.name, type: channels.type })
      .from(channels)
      .where(eq(channels.serverId, serverId))
  )
    .filter((c) => c.type === ChannelType.TEXT)
    .map((c) => c.name)
    .sort();

/** Link and wait for the first sync. */
const linkServer = async (
  caller: Awaited<ReturnType<typeof initTest>>['caller'],
  input: Partial<Parameters<typeof caller.servers.bridgeLink>[0]> = {}
) => {
  const view = await caller.servers.bridgeLink({
    remoteGuildId: GUILD,
    mode: 'match',
    ...input
  });
  await awaitServerBridgeSyncs();
  return view;
};

describe('servers.bridge* — without the plugin', () => {
  test('status says the bridge is unavailable; linking and listing are preconditions', async () => {
    const { caller } = await initTest(1);

    expect(await caller.servers.bridgeStatus()).toMatchObject({
      available: false,
      link: null,
      counts: { paired: 0, excluded: 0, manual: 0 },
      sync: { running: false, last: null }
    });
    await expect(
      caller.servers.bridgeLink({ remoteGuildId: GUILD })
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED'
    });
    await expect(caller.servers.bridgeRemoteGuilds()).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED'
    });
    await expect(caller.servers.bridgeSync()).rejects.toMatchObject({
      code: 'NOT_FOUND'
    });
    expect(await serverLinkRows()).toHaveLength(0);
  });
});

describe('servers.bridgeLink — match mode', () => {
  test('links the server, hands the plugin its copy and pairs same-name text channels with the default direction; nothing is created', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    await createTestChannel({ serverId: 1, name: 'Raids', categoryId: 1 });
    await createTestChannel({ serverId: 1, name: 'lonely', categoryId: 1 });
    await createTestChannel({
      serverId: 1,
      name: 'secret',
      categoryId: 1,
      e2ee: true
    });

    try {
      const view = await linkServer(caller, { defaultDirection: 'inbound' });
      expect(view).toMatchObject({
        serverId: 1,
        remoteGuildId: GUILD,
        mode: 'match',
        createMissing: 'none',
        defaultDirection: 'inbound',
        createdBy: 1
      });
      expect(JSON.stringify(view)).not.toContain('pluginId');
      expect(fixtureCalls('server-links/upsert').map((c) => c.body)).toEqual([
        {
          serverId: 1,
          remoteGuildId: GUILD,
          mode: 'match',
          createMissing: 'none',
          defaultDirection: 'inbound'
        }
      ]);

      const rows = await linkRows();
      expect(
        rows.map((r) => [
          r.remoteChannelId,
          r.direction,
          r.serverLinkId,
          r.excluded
        ])
      ).toEqual([
        [GENERAL, 'inbound', view.id, false],
        [RAIDS, 'inbound', view.id, false]
      ]);
      expect(
        rows.every(
          (r) =>
            r.webhookId !== null &&
            decryptImportToken(r.webhookTokenCiphertext!) ===
              `tok-${r.webhookId}`
        )
      ).toBe(true);
      expect(fixtureCalls('remote/create-channel')).toHaveLength(0);
      expect(await channelNames()).toEqual([
        'General',
        'Raids',
        'lonely',
        'secret'
      ]);

      const status = await caller.servers.bridgeStatus();
      expect(status).toMatchObject({
        available: true,
        configured: true,
        connected: true,
        botUser: { id: '9', name: 'pulse-bridge' },
        remoteGuildName: 'Night Raiders',
        counts: { paired: 2, excluded: 0, manual: 0 },
        sync: { running: false }
      });
      expect(status.sync.last).toMatchObject({
        trigger: 'link',
        paired: 2,
        createdHere: 0,
        createdThere: 0,
        removed: 0,
        error: null
      });
      expect(status.sync.last!.skipped).toEqual([
        { name: 'Voice', side: 'there', reason: 'voice channel' },
        { name: 'forum', side: 'there', reason: 'forum' },
        // Local channels come in tree order (category, position, id).
        { name: 'secret', side: 'here', reason: 'end-to-end encrypted' },
        { name: 'Voice', side: 'here', reason: 'voice channel' },
        {
          name: 'lonely',
          side: 'here',
          reason: 'no channel of that name over there'
        },
        { name: 'news', side: 'there', reason: 'no channel of that name here' }
      ]);
      expect(JSON.stringify(status)).not.toContain('tok-');
    } finally {
      await cleanup();
    }
  });

  test('a replayed sync creates nothing twice; the button starts one and the status shows it', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      await linkServer(caller);
      const upserts = fixtureCalls('links/upsert').length;

      expect(await caller.servers.bridgeSync()).toEqual({ started: true });
      await awaitServerBridgeSyncs();
      await syncServerBridge(1, 'manual');

      expect(fixtureCalls('links/upsert')).toHaveLength(upserts);
      expect(await linkRows()).toHaveLength(1);
      expect((await caller.servers.bridgeStatus()).sync.last).toMatchObject({
        trigger: 'manual',
        paired: 0
      });
    } finally {
      await cleanup();
    }
  });

  test('a member without MANAGE_SETTINGS is refused everywhere; a guild linked by another community is a CONFLICT; a guild the bot is not in is refused', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      const member = await insertMemberUser();
      const { caller: memberCaller } = await initTest(member.id);
      await expect(memberCaller.servers.bridgeStatus()).rejects.toMatchObject({
        code: 'FORBIDDEN'
      });
      await expect(
        memberCaller.servers.bridgeLink({ remoteGuildId: GUILD })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(memberCaller.servers.bridgeUnlink()).rejects.toMatchObject({
        code: 'FORBIDDEN'
      });
      await expect(memberCaller.servers.bridgeSync()).rejects.toMatchObject({
        code: 'FORBIDDEN'
      });
      await expect(
        memberCaller.servers.bridgeRemoteGuilds()
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });

      const other = await insertOtherServer();
      await getTestDb().insert(bridgeServerLinks).values({
        pluginId: BRIDGE_PLUGIN_ID,
        serverId: other.id,
        remoteGuildId: GUILD,
        mode: 'match',
        createMissing: 'none',
        defaultDirection: 'both',
        createdBy: null,
        createdAt: Date.now()
      });
      await expect(
        caller.servers.bridgeLink({ remoteGuildId: GUILD })
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      await expect(
        caller.servers.bridgeLink({ remoteGuildId: '100000000000000099' })
      ).rejects.toThrow('The bot is not in that server');
      await expect(
        caller.servers.bridgeLink({ remoteGuildId: 'abc' })
      ).rejects.toThrow();
      expect(await serverLinkRows()).toHaveLength(1);

      expect(await caller.servers.bridgeRemoteGuilds()).toEqual(
        fixture().guilds
      );
    } finally {
      await cleanup();
    }
  });

  test("changing the default direction moves the pairs that still carried the old one and keeps a channel's own override", async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const raids = await createTestChannel({
      serverId: 1,
      name: 'raids',
      categoryId: 1
    });

    try {
      await linkServer(caller);
      // The owner overrides #raids on its own tab.
      await caller.channels.bridgeLink({
        channelId: raids,
        remoteGuildId: GUILD,
        remoteChannelId: RAIDS,
        direction: 'outbound'
      });
      fixture().calls.length = 0;

      const view = await linkServer(caller, { defaultDirection: 'inbound' });
      expect(view.defaultDirection).toBe('inbound');
      const rows = await linkRows();
      expect(rows.map((r) => [r.remoteChannelId, r.direction])).toEqual([
        [GENERAL, 'inbound'],
        [RAIDS, 'outbound']
      ]);

      // The moved pair is re-pushed with its known webhook and token; nothing new is created.
      const pushes = fixtureCalls('links/upsert');
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.body).toMatchObject({
        remoteChannelId: GENERAL,
        direction: 'inbound',
        webhookId: rows[0]!.webhookId
      });
      expect(typeof pushes[0]!.body.webhookToken).toBe('string');
      expect(await serverLinkRows()).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });
});

describe('servers.bridgeLink — mirror mode', () => {
  test('creates what is missing on both sides, mirroring categories, and is idempotent on replay', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const staff = await createTestCategory({
      serverId: 1,
      name: 'Staff',
      position: 5
    });
    await createTestChannel({
      serverId: 1,
      name: 'Officers Lounge',
      categoryId: staff
    });

    try {
      const view = await linkServer(caller, {
        mode: 'mirror',
        createMissing: 'both'
      });
      expect(view).toMatchObject({ mode: 'mirror', createMissing: 'both' });

      // Over there: a Staff category and an "Officers Lounge" channel in it.
      expect(fixtureCalls('remote/create-channel').map((c) => c.body)).toEqual([
        { guildId: GUILD, name: 'Officers Lounge', categoryName: 'Staff' }
      ]);
      expect(fixture().categories.map((c) => c.name)).toEqual([
        'Chat',
        'Staff'
      ]);

      // Here: "raids" and "news". raids goes under a new "Chat" category
      // (its remote parent); news sits top-level there, so it lands in the
      // first category here.
      expect(await channelNames()).toEqual([
        'General',
        'Officers Lounge',
        'news',
        'raids'
      ]);
      const cats = await getTestDb()
        .select()
        .from(categories)
        .where(eq(categories.serverId, 1));
      expect(cats.map((c) => c.name).sort()).toEqual([
        'Chat',
        'Staff',
        'Text Channels',
        'Voice Channels'
      ]);
      const [raids] = await getTestDb()
        .select()
        .from(channels)
        .where(eq(channels.name, 'raids'));
      expect(raids!.categoryId).toBe(cats.find((c) => c.name === 'Chat')!.id);
      const [news] = await getTestDb()
        .select()
        .from(channels)
        .where(eq(channels.name, 'news'));
      expect(news!.categoryId).toBe(1);

      const rows = await linkRows();
      expect(rows).toHaveLength(4);
      expect(
        rows.every((r) => r.serverLinkId === view.id && r.webhookId !== null)
      ).toBe(true);

      const status = await caller.servers.bridgeStatus();
      expect(status.counts).toEqual({ paired: 4, excluded: 0, manual: 0 });
      expect(status.sync.last).toMatchObject({
        paired: 4,
        createdHere: 2,
        createdThere: 1,
        removed: 0
      });

      // Replay: nothing new on either side.
      const creates = fixtureCalls('remote/create-channel').length;
      const upserts = fixtureCalls('links/upsert').length;
      await syncServerBridge(1, 'manual');
      expect(fixtureCalls('remote/create-channel')).toHaveLength(creates);
      expect(fixtureCalls('links/upsert')).toHaveLength(upserts);
      expect(await linkRows()).toHaveLength(4);
      expect(await channelNames()).toEqual([
        'General',
        'Officers Lounge',
        'news',
        'raids'
      ]);
    } finally {
      await cleanup();
    }
  });

  test('createMissing=here / there each create on one side only; a remote creation failure is reported, not fatal', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    await createTestChannel({ serverId: 1, name: 'lonely', categoryId: 1 });

    try {
      await linkServer(caller, { mode: 'mirror', createMissing: 'here' });
      expect(fixtureCalls('remote/create-channel')).toHaveLength(0);
      expect(await channelNames()).toEqual([
        'General',
        'lonely',
        'news',
        'raids'
      ]);

      fixture().failCreate = 'Missing Permissions';
      await linkServer(caller, { mode: 'mirror', createMissing: 'there' });
      const status = await caller.servers.bridgeStatus();
      expect(status.sync.last!.skipped).toContainEqual({
        name: 'lonely',
        side: 'here',
        reason: 'could not create it over there: Missing Permissions'
      });
      expect(status.sync.last!.error).toBeNull();
      expect(status.sync.last!.createdThere).toBe(0);
    } finally {
      await cleanup();
    }
  });
});

describe('keeping in step', () => {
  test('a channel created here (route and plugin action) is paired by the next sync, which runs on its own', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      await linkServer(caller);
      expect(await linkRows()).toHaveLength(1);

      const newsId = await caller.channels.add({
        serverId: 1,
        type: ChannelType.TEXT,
        name: 'News',
        categoryId: 1
      });
      await awaitServerBridgeSyncs();
      let rows = await linkRows();
      expect(rows.map((r) => [r.channelId, r.remoteChannelId])).toContainEqual([
        newsId,
        NEWS
      ]);
      expect((await caller.servers.bridgeStatus()).sync.last?.trigger).toBe(
        'channel-created'
      );

      const handler = pluginHttp.get(BRIDGE_PLUGIN_ID, 'test/create-local')!;
      const created = (
        await handler({
          method: 'POST',
          path: 'test/create-local',
          headers: {},
          query: {},
          body: { serverId: 1, name: 'raids' }
        })
      ).body as { id: number };
      await awaitServerBridgeSyncs();
      rows = await linkRows();
      expect(rows.map((r) => [r.channelId, r.remoteChannelId])).toContainEqual([
        created.id,
        RAIDS
      ]);
      expect(rows).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });

  test('a channel created here while no server link exists costs nothing but one lookup', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      await caller.channels.add({
        serverId: 1,
        type: ChannelType.TEXT,
        name: 'quiet',
        categoryId: 1
      });
      await awaitServerBridgeSyncs();
      expect(fixture().calls).toEqual([]);
      expect(await linkRows()).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });

  test('a remote channel that vanished ends its pair (row and plugin copy) and leaves the local channel; a rename keeps the pair', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      await linkServer(caller);
      fixture().channels.find((c) => c.id === GENERAL)!.name =
        'general-renamed';
      await syncServerBridge(1, 'manual');
      expect((await linkRows()).map((r) => r.remoteChannelId)).toEqual([
        GENERAL
      ]);

      fixture().channels = fixture().channels.filter((c) => c.id !== GENERAL);
      fixture().calls.length = 0;
      await syncServerBridge(1, 'manual');
      expect(await linkRows()).toHaveLength(0);
      expect(fixtureCalls('links/remove').map((c) => c.body)).toEqual([
        { channelId: 1 }
      ]);
      expect(await channelNames()).toEqual(['General']);
      expect((await caller.servers.bridgeStatus()).sync.last).toMatchObject({
        removed: 1
      });
    } finally {
      await cleanup();
    }
  });

  test('the tick syncs when the plugin reports a change over there, when no run is on record, or when the last one is old — and otherwise not', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const now = Date.now();

    try {
      await linkServer(caller);
      fixture().calls.length = 0;

      // Fresh run on record, nothing requested: the tick only asks the status.
      await bridgeSyncTick(now);
      await awaitServerBridgeSyncs();
      expect(fixtureCalls('channels')).toHaveLength(0);
      expect(fixtureCalls('status')).toHaveLength(1);

      // The remote side changed (counter moved): one sync.
      fixture().syncRequested['1'] = 1;
      await bridgeSyncTick(now);
      await awaitServerBridgeSyncs();
      expect(fixtureCalls('channels')).toHaveLength(1);
      expect((await caller.servers.bridgeStatus()).sync.last?.trigger).toBe(
        'tick'
      );

      // Same counter again: no sync.
      fixture().calls.length = 0;
      await bridgeSyncTick(now);
      await awaitServerBridgeSyncs();
      expect(fixtureCalls('channels')).toHaveLength(0);

      // Half an hour later: a full reconcile even without a request.
      await bridgeSyncTick(now + 31 * 60_000);
      await awaitServerBridgeSyncs();
      expect(fixtureCalls('channels')).toHaveLength(1);

      // Nothing on record (restart): the first tick syncs.
      resetServerBridgeSyncState();
      fixture().calls.length = 0;
      await bridgeSyncTick(now);
      await awaitServerBridgeSyncs();
      expect(fixtureCalls('channels')).toHaveLength(1);
    } finally {
      await cleanup();
    }
  });

  test('opening the status reconciles the copies and starts a sync when the plugin reports a change', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      await linkServer(caller);
      const [row] = await linkRows();

      // The plugin lost its copy: pushed again with the decrypted token.
      delete fixture().links[String(row!.channelId)];
      fixture().calls.length = 0;
      await caller.servers.bridgeStatus();
      const pushes = fixtureCalls('links/upsert');
      expect(pushes).toHaveLength(1);
      expect(pushes[0]!.body).toMatchObject({
        channelId: row!.channelId,
        webhookId: row!.webhookId,
        webhookToken: `tok-${row!.webhookId}`
      });
      expect(fixtureCalls('server-links/upsert')).toHaveLength(1);

      // The plugin holds a link the server does not: removed from the plugin.
      fixture().links['999'] = {
        serverId: 1,
        remoteChannelId: '200000000000000055',
        webhookId: '91'
      };
      fixture().calls.length = 0;
      await caller.servers.bridgeStatus();
      expect(fixtureCalls('links/remove').map((c) => c.body)).toEqual([
        { channelId: 999 }
      ]);

      // A change over there: the status call starts the catch-up.
      fixture().syncRequested['1'] = 5;
      fixture().calls.length = 0;
      await caller.servers.bridgeStatus();
      await awaitServerBridgeSyncs();
      expect(fixtureCalls('channels')).toHaveLength(1);
      expect((await caller.servers.bridgeStatus()).sync.last?.trigger).toBe(
        'status'
      );
    } finally {
      await cleanup();
    }
  });
});

describe('channels.bridgeExclude and the channel tab under a server link', () => {
  test('excluding a paired channel drops its webhook and keeps the row out of the next sync; including again re-pairs it', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      await linkServer(caller);
      const before = await caller.channels.bridgeStatus({ channelId: 1 });
      expect(before.serverLink).toEqual({
        id: before.link!.serverLinkId!,
        remoteGuildId: GUILD,
        remoteGuildName: 'Night Raiders',
        mode: 'match',
        defaultDirection: 'both'
      });
      fixture().calls.length = 0;

      const excluded = await caller.channels.bridgeExclude({
        channelId: 1,
        excluded: true
      });
      expect(excluded).toMatchObject({
        channelId: 1,
        remoteChannelId: GENERAL,
        excluded: true,
        webhookId: null
      });
      expect(fixtureCalls('links/remove').map((c) => c.body)).toEqual([
        { channelId: 1 }
      ]);
      const [row] = await linkRows();
      expect(row).toMatchObject({
        excluded: true,
        webhookId: null,
        webhookTokenCiphertext: null
      });
      expect(row!.serverLinkId).not.toBeNull();

      await syncServerBridge(1, 'manual');
      expect(fixtureCalls('links/upsert')).toHaveLength(0);
      expect((await caller.servers.bridgeStatus()).counts).toEqual({
        paired: 0,
        excluded: 1,
        manual: 0
      });
      // Idempotent.
      expect(
        (await caller.channels.bridgeExclude({ channelId: 1, excluded: true }))
          ?.excluded
      ).toBe(true);

      expect(
        await caller.channels.bridgeExclude({ channelId: 1, excluded: false })
      ).toBeNull();
      await awaitServerBridgeSyncs();
      const rows = await linkRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channelId: 1,
        remoteChannelId: GENERAL,
        excluded: false
      });
      expect(rows[0]!.webhookId).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('excluding a channel that never paired stops mirror mode from creating its twin; a hand-made link cannot be excluded; scope and preconditions hold', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const lonely = await createTestChannel({
      serverId: 1,
      name: 'lonely',
      categoryId: 1
    });
    const other = await insertOtherServer();
    const foreign = await createTestChannel({
      serverId: other.id,
      name: 'theirs'
    });

    try {
      await expect(
        caller.channels.bridgeExclude({ channelId: lonely, excluded: true })
      ).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED'
      });

      await linkServer(caller);
      const placeholder = await caller.channels.bridgeExclude({
        channelId: lonely,
        excluded: true
      });
      expect(placeholder).toMatchObject({
        channelId: lonely,
        excluded: true,
        webhookId: null
      });
      expect(placeholder!.remoteChannelId.startsWith('excluded:')).toBe(true);

      await linkServer(caller, { mode: 'mirror', createMissing: 'there' });
      expect(fixtureCalls('remote/create-channel')).toHaveLength(0);
      expect(
        (await caller.channels.bridgeStatus({ channelId: lonely })).link
      ).toMatchObject({ excluded: true });

      await expect(
        caller.channels.bridgeExclude({ channelId: foreign, excluded: true })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const manual = await createTestChannel({
        serverId: 1,
        name: 'by-hand',
        categoryId: 1
      });
      await caller.channels.bridgeLink({
        channelId: manual,
        remoteGuildId: GUILD,
        remoteChannelId: NEWS
      });
      await expect(
        caller.channels.bridgeExclude({ channelId: manual, excluded: true })
      ).rejects.toThrow('linked on its own');
      expect((await caller.servers.bridgeStatus()).counts.manual).toBe(1);

      const member = await insertMemberUser();
      const { caller: memberCaller } = await initTest(member.id);
      await expect(
        memberCaller.channels.bridgeExclude({
          channelId: lonely,
          excluded: false
        })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await cleanup();
    }
  });
});

describe('servers.bridgeUnlink', () => {
  test('removes every pair of the link and its webhooks, tells the plugin, keeps the channels on both sides and hand-made links', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();
    const manual = await createTestChannel({
      serverId: 1,
      name: 'by-hand',
      categoryId: 1
    });

    try {
      await linkServer(caller, { mode: 'mirror', createMissing: 'both' });
      await caller.channels.bridgeLink({
        channelId: manual,
        remoteGuildId: OTHER_GUILD,
        remoteChannelId: '200000000000000066'
      });
      await caller.channels.bridgeExclude({ channelId: 1, excluded: true });
      const paired = (await linkRows()).filter(
        (r) => r.serverLinkId !== null && r.webhookId !== null
      );
      expect(paired).toHaveLength(2);
      fixture().calls.length = 0;

      expect(await caller.servers.bridgeUnlink()).toEqual({ removed: 2 });

      expect(await serverLinkRows()).toHaveLength(0);
      const rows = await linkRows();
      expect(rows.map((r) => r.channelId)).toEqual([manual]);
      expect(fixtureCalls('links/remove-many').map((c) => c.body)).toEqual([
        { channelIds: paired.map((r) => r.channelId).sort((a, b) => a - b) }
      ]);
      expect(fixtureCalls('server-links/remove').map((c) => c.body)).toEqual([
        { serverId: 1 }
      ]);
      expect(await channelNames()).toEqual([
        'General',
        'by-hand',
        'news',
        'raids'
      ]);
      expect(fixture().channels.map((c) => c.name)).toContain('by-hand');

      await expect(caller.servers.bridgeUnlink()).rejects.toMatchObject({
        code: 'NOT_FOUND'
      });
      expect((await caller.servers.bridgeStatus()).link).toBeNull();
    } finally {
      await cleanup();
    }
  });

  test('linking a different remote server tears the old link down first', async () => {
    const { caller } = await initTest(1);
    const cleanup = await loadFixturePlugin();

    try {
      const first = await linkServer(caller);
      expect(await linkRows()).toHaveLength(1);
      fixture().calls.length = 0;

      const second = await linkServer(caller, { remoteGuildId: OTHER_GUILD });
      expect(second.id).not.toBe(first.id);
      expect(second.remoteGuildId).toBe(OTHER_GUILD);
      expect(await serverLinkRows()).toHaveLength(1);
      expect(fixtureCalls('links/remove-many')).toHaveLength(1);
      expect(fixtureCalls('server-links/remove').map((c) => c.body)).toEqual([
        { serverId: 1 }
      ]);
      // The other guild has no channels in the fixture: nothing pairs.
      expect(await linkRows()).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
