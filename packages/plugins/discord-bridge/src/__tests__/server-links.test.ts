import { describe, expect, test } from 'bun:test';
import { createMemoryStorage } from '../store';
import { createBridgeHarness, type TBridgeHarness } from './harness';

/**
 * The plugin's half of whole-server bridging: it keeps a copy of each
 * server link, lists what the server needs to pair (channels with
 * categories, plus what it would not bridge), creates a remote channel
 * under a category of the same name, tears many links down at once, and
 * turns gateway channel events in a linked guild into a sync request the
 * server reads from `status`. The pairing decision itself is the
 * server's (routers/servers/bridge-pairing.ts).
 */

const GUILD = '100000000000000001';
const OTHER_GUILD = '100000000000000002';
const GENERAL = '200000000000000001';
const RAIDS = '200000000000000002';
const WEBHOOK = '910000000000000001';
const WEBHOOK_2 = '910000000000000002';

const serverLink = (overrides: Record<string, unknown> = {}) => ({
  serverId: 1,
  remoteGuildId: GUILD,
  mode: 'mirror' as const,
  createMissing: 'both' as const,
  defaultDirection: 'both' as const,
  ...overrides
});

const link = (h: TBridgeHarness, channelId: number, remoteChannelId: string) =>
  h.call('links/upsert', { channelId, serverId: 1, remoteGuildId: GUILD, remoteChannelId, direction: 'both' });

const restCalls = (h: TBridgeHarness) => h.transport.calls.map((c) => `${c.method} ${c.path}`);

const connected = async () => {
  const h = createBridgeHarness();
  await h.bridge.start();
  h.connect();
  return h;
};

describe('server-link copies', () => {
  test('upsert and remove keep a validated copy that survives a restart', async () => {
    const storage = createMemoryStorage();
    const h = createBridgeHarness({ storage });
    await h.bridge.start();

    expect((await h.call('server-links/upsert', serverLink())).status).toBe(200);
    expect((await h.call('server-links/upsert', serverLink({ mode: 'sideways' }))).status).toBe(400);
    expect((await h.call('server-links/upsert', serverLink({ remoteGuildId: 'nope' }))).status).toBe(400);
    expect((await h.call('server-links/upsert', serverLink({ createMissing: 'all' }))).status).toBe(400);
    expect(h.bridge.store.serverLinks.get(1)).toEqual(serverLink());
    expect(h.bridge.store.serverLinkForGuild(GUILD)?.serverId).toBe(1);

    await h.bridge.stop();
    const again = createBridgeHarness({ storage });
    await again.bridge.start();
    expect(again.bridge.store.serverLinks.get(1)).toEqual(serverLink());

    expect((await again.call('server-links/remove', { serverId: 1 })).body).toEqual({ removed: true });
    expect((await again.call('server-links/remove', { serverId: 1 })).body).toEqual({ removed: false });
    expect((await again.call('server-links/remove', { serverId: 'x' })).status).toBe(400);
    expect(again.bridge.store.serverLinks.size).toBe(0);
  });

  test('the listing carries categories, parent ids and the channels a sync skips, with reasons', async () => {
    const h = await connected();

    const listing = (await h.call('channels', { guildId: GUILD })).body as {
      channels: { id: string; parentId: string | null; parentName: string | null }[];
      categories: { id: string; name: string }[];
      skipped: { id: string; name: string; reason: string }[];
    };

    expect(listing.categories).toEqual([{ id: '200000000000000009', name: 'Chat' }]);
    expect(listing.channels.map((c) => [c.id, c.parentId, c.parentName])).toEqual([
      [GENERAL, '200000000000000009', 'Chat'],
      [RAIDS, '200000000000000009', 'Chat'],
      ['200000000000000004', null, null]
    ]);
    expect(listing.skipped).toEqual([
      { id: '200000000000000003', name: 'Voice', reason: 'voice channel' },
      { id: '200000000000000005', name: 'forum', reason: 'forum' }
    ]);
  });
});

describe('creating channels over there', () => {
  test('a channel is created under the existing category of the same (normalised) name', async () => {
    const h = await connected();

    const created = await h.call('remote/create-channel', { guildId: GUILD, name: 'strategy', categoryName: 'chat' });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({
      id: '200000000000000077',
      name: 'strategy',
      parentId: '200000000000000009',
      parentName: 'Chat'
    });

    // One listing to find the category, one create: no category made.
    expect(restCalls(h)).toEqual([`GET /guilds/${GUILD}/channels`, `POST /guilds/${GUILD}/channels`]);
    const create = h.transport.calls[1]!;
    expect(create.body).toEqual({ name: 'strategy', type: 0, parent_id: '200000000000000009' });
    expect(create.headers['X-Audit-Log-Reason'] ?? create.headers['x-audit-log-reason']).toBeDefined();
  });

  test('a missing category is created first, then the channel inside it; the cache learns both', async () => {
    const h = await connected();
    h.transport.respond(`POST /guilds/${GUILD}/channels`, (call) => {
      const body = call.body as { type: number; name: string };
      return body.type === 4
        ? { status: 201, body: { id: '200000000000000088', type: 4, name: body.name, position: 7 } }
        : {
            status: 201,
            body: { id: '200000000000000089', type: 0, name: body.name, parent_id: '200000000000000088', position: 8 }
          };
    });

    const created = await h.call('remote/create-channel', { guildId: GUILD, name: 'Officers Lounge', categoryName: 'Staff' });
    expect(created.body).toEqual({
      id: '200000000000000089',
      name: 'Officers Lounge',
      parentId: '200000000000000088',
      parentName: 'Staff'
    });
    expect(h.transport.calls.map((c) => c.body)).toEqual([
      null,
      { name: 'Staff', type: 4 },
      { name: 'Officers Lounge', type: 0, parent_id: '200000000000000088' }
    ]);

    // A second channel for the same category reuses it (the fresh
    // listing is what decides, so the answer must include it).
    h.transport.respond(`GET /guilds/${GUILD}/channels`, {
      status: 200,
      body: [{ id: '200000000000000088', type: 4, name: 'Staff', position: 7 }]
    });
    h.transport.calls.length = 0;
    await h.call('remote/create-channel', { guildId: GUILD, name: 'second', categoryName: 'staff' });
    expect(h.transport.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  test('top-level channels need no listing; bad input and a missing token are refused; API failures are reported', async () => {
    const h = await connected();

    await h.call('remote/create-channel', { guildId: GUILD, name: 'lobby', categoryName: null });
    expect(restCalls(h)).toEqual([`POST /guilds/${GUILD}/channels`]);
    expect(h.transport.calls[0]!.body).toEqual({ name: 'lobby', type: 0, parent_id: undefined });

    expect((await h.call('remote/create-channel', { guildId: 'x', name: 'lobby' })).status).toBe(400);
    expect((await h.call('remote/create-channel', { guildId: GUILD, name: '' })).status).toBe(400);

    h.transport.respond(`POST /guilds/${GUILD}/channels`, { status: 403, body: { message: 'Missing Permissions' } });
    const failed = await h.call('remote/create-channel', { guildId: GUILD, name: 'lobby' });
    expect(failed.status).toBe(502);
    expect((failed.body as { error: string }).error).toContain('Missing Permissions');

    const idle = createBridgeHarness({ token: '' });
    await idle.bridge.start();
    expect((await idle.call('remote/create-channel', { guildId: GUILD, name: 'lobby' })).status).toBe(409);
  });
});

describe('removing many links at once', () => {
  test('the links go immediately, the webhooks one by one in the background; unknown ids are ignored', async () => {
    const h = await connected();
    await link(h, 10, GENERAL);
    await link(h, 11, RAIDS);
    h.bridge.store.setThread({ localThreadId: 50, remoteThreadId: 't', channelId: 10, remoteChannelId: GENERAL });
    h.transport.calls.length = 0;

    const removed = await h.call('links/remove-many', { channelIds: [10, 11, 12] });
    expect(removed.body).toEqual({ removed: 2 });
    expect(h.bridge.store.links.size).toBe(0);
    expect(h.bridge.store.threads.size).toBe(0);

    await h.bridge.idle();
    expect(restCalls(h)).toEqual([`DELETE /webhooks/${WEBHOOK}`, `DELETE /webhooks/${WEBHOOK_2}`]);

    expect((await h.call('links/remove-many', { channelIds: 'all' })).status).toBe(400);
    expect((await h.call('links/remove-many', { channelIds: [] })).body).toEqual({ removed: 0 });
  });
});

describe('status for a whole server', () => {
  test('serverIds expand to every link into the server; guild names and sync counters ride along', async () => {
    const h = await connected();
    await h.call('server-links/upsert', serverLink());
    await link(h, 10, GENERAL);
    await link(h, 11, RAIDS);

    const status = (await h.call('status', { serverIds: [1], guildIds: [GUILD, OTHER_GUILD] })).body as {
      links: Record<string, { known: boolean }>;
      guilds: Record<string, { name: string }>;
      syncRequested: Record<string, number>;
    };

    expect(Object.keys(status.links).sort()).toEqual(['10', '11']);
    expect(status.guilds).toEqual({ [GUILD]: { name: 'Night Raiders' } });
    expect(status.syncRequested).toEqual({ '1': 0 });
  });
});

describe('gateway channel events under a server link', () => {
  test('connecting asks for a sync of every linked server; a text channel created over there asks again; voice and other guilds do not', async () => {
    const h = createBridgeHarness();
    await h.bridge.start();
    await h.call('server-links/upsert', serverLink());
    expect(h.bridge.syncRequestsFor(1)).toBe(0);

    h.connect();
    expect(h.bridge.syncRequestsFor(1)).toBe(1);

    await h.dispatch(h.gateway.channelCreate);
    expect(h.bridge.syncRequestsFor(1)).toBe(2);

    await h.dispatch(h.gateway.channelCreateVoice);
    await h.dispatch(h.gateway.channelCreateOtherGuild);
    expect(h.bridge.syncRequestsFor(1)).toBe(2);

    // Without a server link for the guild, nothing is asked.
    await h.call('server-links/remove', { serverId: 1 });
    await h.dispatch(h.gateway.channelCreate);
    expect(h.bridge.syncRequestsFor(1)).toBe(0);
  });

  test('a rename keeps the pair; deleting the linked remote channel ends the pair here and asks for a sync, nothing is deleted on our side', async () => {
    const h = await connected();
    await h.call('server-links/upsert', serverLink());
    await link(h, 10, GENERAL);
    h.bridge.store.setThread({ localThreadId: 50, remoteThreadId: 't', channelId: 10, remoteChannelId: GENERAL });
    const before = h.bridge.syncRequestsFor(1);
    h.fake.actions.length = 0;
    h.transport.calls.length = 0;

    await h.dispatch(h.gateway.channelUpdateRename);
    expect(h.bridge.store.links.get(10)?.remoteChannelId).toBe(GENERAL);
    expect(h.bridge.syncRequestsFor(1)).toBe(before);

    await h.dispatch(h.gateway.channelDeleteLinked);
    expect(h.bridge.store.links.has(10)).toBe(false);
    expect(h.bridge.store.threads.size).toBe(0);
    expect(h.bridge.syncRequestsFor(1)).toBe(before + 1);
    expect(h.fake.actions).toEqual([]);
    expect(restCalls(h)).toEqual([]);
    expect(h.fake.logs.some((l) => l.includes('no longer bridged'))).toBe(true);

    // A message for the vanished channel is dropped, not posted.
    await h.dispatch(h.gateway.messageCreate);
    expect(h.fake.actions).toEqual([]);

    // An unlinked text channel going away in a linked guild also asks
    // for a sync (match mode may have been waiting on it).
    await h.dispatch(h.gateway.channelDeleteUnlinked);
    expect(h.bridge.syncRequestsFor(1)).toBe(before + 2);
  });
});
