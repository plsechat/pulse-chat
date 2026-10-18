import { describe, expect, test } from 'bun:test';
import { PLUGIN_ID, WEBHOOK_NAME } from '../bridge';
import { createMemoryStorage } from '../store';
import { createBridgeHarness, type TBridgeHarness } from './harness';

const GUILD = '100000000000000001';
const GENERAL = '200000000000000001';
const RAIDS = '200000000000000002';
const WEBHOOK = '910000000000000001';
const WEBHOOK_TOKEN = 'wh-token-1';

const linkGeneral = (h: TBridgeHarness, direction: 'both' | 'inbound' | 'outbound' = 'both') =>
  h.call('links/upsert', {
    channelId: 10,
    serverId: 1,
    remoteGuildId: GUILD,
    remoteChannelId: GENERAL,
    direction
  });

/** A started, connected bridge with #10 linked to the remote general channel. */
const linkedBridge = async (direction: 'both' | 'inbound' | 'outbound' = 'both') => {
  const h = createBridgeHarness();
  await h.bridge.start();
  h.connect();
  const linked = await linkGeneral(h, direction);
  expect(linked.status).toBe(200);
  h.transport.calls.length = 0;
  h.fake.actions.length = 0;
  return h;
};

const restCalls = (h: TBridgeHarness) => h.transport.calls.map((c) => `${c.method} ${c.path}`);
const actionNames = (h: TBridgeHarness) => h.fake.actions.map((a) => a.name);

describe('lifecycle and routes', () => {
  test('without a token the bridge registers its routes and stays idle; status says so', async () => {
    const h = createBridgeHarness({ token: '' });
    await h.bridge.start();

    expect(h.sockets.sockets).toHaveLength(0);
    expect([...h.fake.routes.keys()].sort()).toEqual([
      'channels',
      'links/remove',
      'links/remove-many',
      'links/upsert',
      'remote/create-channel',
      'server-links/remove',
      'server-links/upsert',
      'status'
    ]);

    const status = await h.call('status', { channelIds: [10] });
    expect(status.body).toMatchObject({ configured: false, connected: false, botUser: null });
    expect((await h.call('channels', {})).status).toBe(409);
    expect(h.fake.logs.some((l) => l.includes('No bot token'))).toBe(true);
  });

  test('channels route lists the bot\'s guilds, then the linkable channels of one guild in position order', async () => {
    const h = createBridgeHarness();
    await h.bridge.start();

    const guilds = await h.call('channels', {});
    expect(guilds.body).toEqual({
      guilds: [
        { id: GUILD, name: 'Night Raiders', iconUrl: `https://cdn.discordapp.com/icons/${GUILD}/abc123.png?size=64` },
        { id: '100000000000000002', name: 'Second Guild', iconUrl: null }
      ],
      channels: []
    });

    const channels = await h.call('channels', { guildId: GUILD });
    expect((channels.body as { channels: unknown[] }).channels).toEqual([
      { id: GENERAL, guildId: GUILD, name: 'general', parentId: '200000000000000009', parentName: 'Chat', position: 1 },
      { id: RAIDS, guildId: GUILD, name: 'raids', parentId: '200000000000000009', parentName: 'Chat', position: 2 },
      { id: '200000000000000004', guildId: GUILD, name: 'news', parentId: null, parentName: null, position: 3 }
    ]);

    expect((await h.call('channels', { guildId: 'not-a-snowflake' })).status).toBe(400);
  });

  test('linking creates the webhook on the remote channel and reports it; the token is returned once, to the server', async () => {
    const h = createBridgeHarness();
    await h.bridge.start();
    h.connect();

    const linked = await linkGeneral(h);
    expect(linked.status).toBe(200);
    expect(linked.body).toEqual({ webhookId: WEBHOOK, webhookToken: WEBHOOK_TOKEN });
    expect(h.transport.calls[0]).toMatchObject({
      method: 'POST',
      path: `/channels/${GENERAL}/webhooks`,
      body: { name: WEBHOOK_NAME }
    });

    const status = await h.call('status', { channelIds: [10, 11] });
    expect(status.body).toMatchObject({
      configured: true,
      connected: true,
      botUser: { id: '900000000000000001', name: 'pulse-bridge' },
      links: {
        '10': { known: true, mirroredToday: 0, lastError: null },
        '11': { known: false, mirroredToday: 0, lastError: null }
      }
    });
  });

  test('a remote channel already bridged elsewhere is refused; a bad body is refused; a re-push with a known webhook creates none', async () => {
    const h = await linkedBridge();

    const elsewhere = await h.call('links/upsert', {
      channelId: 11,
      serverId: 1,
      remoteGuildId: GUILD,
      remoteChannelId: GENERAL,
      direction: 'both'
    });
    expect(elsewhere.status).toBe(409);

    expect((await h.call('links/upsert', { channelId: 'ten' })).status).toBe(400);
    expect((await h.call('links/upsert', { channelId: 10, serverId: 1, remoteGuildId: GUILD, remoteChannelId: GENERAL, direction: 'sideways' })).status).toBe(400);

    const repush = await h.call('links/upsert', {
      channelId: 10,
      serverId: 1,
      remoteGuildId: GUILD,
      remoteChannelId: GENERAL,
      direction: 'inbound',
      webhookId: WEBHOOK,
      webhookToken: WEBHOOK_TOKEN
    });
    expect(repush.status).toBe(200);
    expect(restCalls(h)).toEqual([]);
    expect(h.bridge.store.links.get(10)?.direction).toBe('inbound');
  });

  test('unlinking deletes the webhook (best effort) and forgets the link and its threads', async () => {
    const h = await linkedBridge();
    h.bridge.store.setThread({ localThreadId: 50, remoteThreadId: 't', channelId: 10, remoteChannelId: GENERAL });

    const removed = await h.call('links/remove', { channelId: 10 });
    expect(removed.body).toEqual({ removed: true });
    expect(restCalls(h)).toEqual([`DELETE /webhooks/${WEBHOOK}`]);
    expect(h.bridge.store.links.size).toBe(0);
    expect(h.bridge.store.threads.size).toBe(0);

    expect((await h.call('links/remove', { channelId: 10 })).body).toEqual({ removed: false });
    expect((await h.call('status', { channelIds: [10] })).body).toMatchObject({ links: { '10': { known: false } } });
  });

  test('stop flushes the state; a new bridge over the same storage knows the link and re-resolves the webhook token through the bot', async () => {
    const storage = createMemoryStorage();
    const first = createBridgeHarness({ storage });
    await first.bridge.start();
    first.connect();
    await linkGeneral(first);
    await first.bridge.stop();
    expect(first.sockets.latest().closed?.code).toBe(1000);
    expect(await storage.load()).not.toContain(WEBHOOK_TOKEN);

    const second = createBridgeHarness({ storage });
    await second.bridge.start();
    second.connect();
    expect(second.bridge.store.links.get(10)?.webhookId).toBe(WEBHOOK);

    await second.fake.emit('message:created', { messageId: 1, channelId: 10, userId: 7, content: 'after restart' });
    expect(restCalls(second)).toEqual([
      `GET /webhooks/${WEBHOOK}`,
      `POST /webhooks/${WEBHOOK}/wh-token-1-refetched`
    ]);
  });

  test('a changed token reconnects; a cleared token stops the gateway', async () => {
    let token = 'bot-token';
    const h = createBridgeHarness({ settings: { botToken: () => token, publicUrl: () => '' } });
    await h.bridge.start();
    h.connect();

    h.bridge.checkSettings();
    expect(h.sockets.sockets).toHaveLength(1);

    token = 'new-token';
    h.bridge.checkSettings();
    expect(h.sockets.sockets).toHaveLength(2);
    expect(h.sockets.sockets[0]!.closed?.code).toBe(1000);

    token = '';
    h.bridge.checkSettings();
    expect(h.sockets.latest().closed?.code).toBe(1000);
    expect(h.bridge.configured).toBe(false);
  });
});

describe('inbound (remote → here)', () => {
  test('a message is posted with the author persona, external id, re-hosted attachments and mapped content', async () => {
    const h = await linkedBridge();

    await h.dispatch(h.gateway.messageCreate);

    expect(actionNames(h)).toEqual(['files.upload', 'messages.post']);
    expect(h.fake.actions[0]!.input).toEqual({
      url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
      filename: 'shot.png',
      mime: 'image/png'
    });
    expect(h.fake.actions[1]!.input).toEqual({
      channelId: 10,
      content:
        'hey @Dave see #raids :pogchamp: @Officers at 2025-10-09 08:53 @here\nA link — https://example.org/post\n:wave:\n[attachment: evil.png]',
      author: {
        name: 'Caz',
        avatarUrl: 'https://cdn.discordapp.com/avatars/600000000000000001/c0ffee.png?size=128'
      },
      externalId: '500000000000000001',
      attachments: [{ fileId: 1 }],
      replyToId: undefined
    });
    expect(h.bridge.store.messageByRemote('500000000000000001')).toMatchObject({ localId: 1001, origin: 'in' });
    expect(h.bridge.store.personas.get('600000000000000001')?.name).toBe('Caz');
    expect((await h.call('status', { channelIds: [10] })).body).toMatchObject({ links: { '10': { mirroredToday: 1 } } });
    expect(restCalls(h)).toEqual([]);
  });

  test('a picker GIF is re-hosted from its allowed host and posted as an attachment without the bare page link', async () => {
    const h = await linkedBridge();

    await h.dispatch(h.gateway.messageCreateGif);

    expect(actionNames(h)).toEqual(['files.upload', 'messages.post']);
    expect(h.fake.actions[0]!.input).toEqual({
      url: 'https://static2.klipy.com/ii/aa/bb/hello.mp4',
      filename: 'hello.mp4',
      mime: 'video/mp4'
    });
    expect(h.fake.actions[1]!.input).toMatchObject({
      channelId: 10,
      content: '',
      attachments: [{ fileId: 1 }],
      externalId: '500000000000000031'
    });
  });

  test('a GIF from a host outside the allowlist is not fetched; the link is what arrives', async () => {
    const h = await linkedBridge();

    await h.dispatch(h.gateway.messageCreateGifElsewhere);

    expect(actionNames(h)).toEqual(['messages.post']);
    expect(h.fake.actions[0]!.input).toMatchObject({
      content: 'https://gifs.example.net/view/nope',
      attachments: undefined
    });
  });

  test("a status bot's card arrives as text, and its edit (an empty body with new embeds) is mirrored", async () => {
    const h = await linkedBridge();

    await h.dispatch(h.gateway.messageCreateStatusCard);
    expect(actionNames(h)).toEqual(['messages.post']);
    expect(h.fake.actions[0]!.input).toMatchObject({
      content: 'Server status\nAll systems go\nPlayers: 12/50\nMap: Island\nUpdated hourly',
      author: { name: 'status-bot' }
    });

    await h.dispatch(h.gateway.messageUpdateStatusCard);
    expect(actionNames(h)).toEqual(['messages.post', 'messages.edit']);
    expect(h.fake.actions[1]!.input).toEqual({
      externalId: '500000000000000033',
      content: 'Server status\nRestarting\nPlayers: 0/50'
    });
  });

  test('a reply resolves to the local copy of the message it answers', async () => {
    const h = await linkedBridge();
    await h.dispatch(h.gateway.messageCreatePlain);
    await h.dispatch(h.gateway.messageCreateReply);

    expect(h.fake.actions[1]!.input).toMatchObject({ content: 'replying', replyToId: 1001, externalId: '500000000000000003' });
  });

  test('our own webhook echo, the bot, system messages and unlinked channels post nothing', async () => {
    const h = await linkedBridge();

    await h.dispatch(h.gateway.messageCreateFromOurWebhook);
    await h.dispatch(h.gateway.messageCreateSystem);
    await h.dispatch(h.gateway.messageCreateUnlinked);
    await h.dispatch({
      t: 'MESSAGE_CREATE',
      d: { ...h.gateway.messageCreatePlain.d, id: '500000000000000099', author: { id: '900000000000000001', username: 'pulse-bridge', bot: true } }
    });

    expect(h.fake.actions).toEqual([]);
  });

  test('an outbound-only link mirrors nothing inward', async () => {
    const h = await linkedBridge('outbound');
    await h.dispatch(h.gateway.messageCreatePlain);
    await h.dispatch(h.gateway.reactionAdd);
    await h.dispatch(h.gateway.threadCreate);
    expect(h.fake.actions).toEqual([]);
  });

  test('edits reach the local copy; embed-only updates and edits of unknown messages are ignored', async () => {
    const h = await linkedBridge();
    await h.dispatch(h.gateway.messageUpdate);
    expect(h.fake.actions).toEqual([]);

    await h.dispatch(h.gateway.messageCreatePlain);
    await h.dispatch(h.gateway.messageUpdateEmbedOnly);
    expect(actionNames(h)).toEqual(['messages.post']);

    await h.dispatch(h.gateway.messageUpdate);
    expect(h.fake.actions[1]).toEqual({
      name: 'messages.edit',
      input: { externalId: '500000000000000002', content: 'plain words, edited' }
    });
  });

  test('a remote delete removes the local copy, and the local delete echo does not bounce back', async () => {
    const h = await linkedBridge();
    await h.dispatch(h.gateway.messageCreatePlain);
    const localId = h.bridge.store.messageByRemote('500000000000000002')!.localId;

    await h.dispatch(h.gateway.messageDelete);
    expect(h.fake.actions[1]).toEqual({ name: 'messages.delete', input: { externalId: '500000000000000002' } });

    // The server emits message:deleted for the row the plugin just removed.
    await h.fake.emit('message:deleted', { messageId: localId, channelId: 10 });
    expect(restCalls(h)).toEqual([]);

    await h.dispatch(h.gateway.messageDelete);
    expect(actionNames(h)).toEqual(['messages.post', 'messages.delete']);
  });

  test('reactions are added and removed on the local copy; the bot\'s own reactions are ignored', async () => {
    const h = await linkedBridge();
    await h.dispatch(h.gateway.messageCreatePlain);

    await h.dispatch(h.gateway.reactionAdd);
    await h.dispatch(h.gateway.reactionAddCustom);
    await h.dispatch(h.gateway.reactionRemove);
    await h.dispatch(h.gateway.reactionAddByBot);

    // Reactions reach the server as shortcodes: the glyph maps to its
    // primary name and a custom emoji to its bare name.
    expect(h.fake.actions.slice(1)).toEqual([
      { name: 'messages.react', input: { messageId: 1001, emoji: '+1', remove: false } },
      { name: 'messages.react', input: { messageId: 1001, emoji: 'pogchamp', remove: false } },
      { name: 'messages.react', input: { messageId: 1001, emoji: '+1', remove: true } }
    ]);
  });

  test('a remote thread becomes a local thread under the starter message, and its messages land inside it', async () => {
    const h = await linkedBridge();
    await h.dispatch(h.gateway.messageCreatePlain);

    await h.dispatch(h.gateway.threadCreate);
    expect(h.fake.actions[1]).toEqual({
      name: 'channels.createThread',
      input: { channelId: 10, parentMessageId: 1001, name: 'plain thread' }
    });
    expect(h.bridge.store.threadByRemote('500000000000000002')?.localThreadId).toBe(501);

    await h.dispatch(h.gateway.messageCreateInThread);
    expect(h.fake.actions[2]!.input).toMatchObject({ channelId: 501, content: 'inside the thread' });

    await h.dispatch(h.gateway.threadCreateByBot);
    await h.dispatch(h.gateway.threadCreate);
    expect(actionNames(h).filter((n) => n === 'channels.createThread')).toHaveLength(1);
  });

  test('a scheduled event over there becomes one here (end defaulted, location noted) without echoing back; updates and cancellation follow', async () => {
    const h = await linkedBridge();

    await h.dispatch(h.gateway.scheduledEventCreate);
    expect(h.fake.actions[0]).toMatchObject({
      name: 'events.create',
      input: {
        serverId: 1,
        title: 'Raid night',
        description: 'Bring flasks Where: Voice',
        startsAt: Date.parse('2026-10-20T19:00:00Z'),
        endsAt: Date.parse('2026-10-20T22:00:00Z'),
        hostId: null
      }
    });
    expect(restCalls(h)).toEqual([]);
    expect(h.bridge.store.eventByRemote('950000000000000001')?.localEventId).toBe(1);

    await h.dispatch(h.gateway.scheduledEventCreateByBot);
    expect(actionNames(h).filter((n) => n === 'events.create')).toHaveLength(1);

    await h.dispatch(h.gateway.scheduledEventUpdate);
    expect(h.fake.actions[1]).toEqual({
      name: 'events.update',
      input: {
        eventId: 1,
        patch: {
          title: 'Raid night (moved)',
          startsAt: Date.parse('2026-10-20T20:00:00Z'),
          endsAt: Date.parse('2026-10-20T23:00:00Z')
        }
      }
    });
    expect(restCalls(h)).toEqual([]);

    await h.dispatch(h.gateway.scheduledEventDelete);
    expect(h.fake.actions[2]).toEqual({ name: 'events.cancel', input: 1 });
    expect(restCalls(h)).toEqual([]);
    expect(h.bridge.store.eventByRemote('950000000000000001')).toBeUndefined();
  });

  test('an edit, reaction and thread arriving while the create is still in flight wait for it', async () => {
    const h = await linkedBridge();

    await Promise.all([
      h.bridge.handleDispatch(h.gateway.messageCreatePlain.t, h.gateway.messageCreatePlain.d),
      h.bridge.handleDispatch(h.gateway.messageUpdate.t, h.gateway.messageUpdate.d),
      h.bridge.handleDispatch(h.gateway.reactionAdd.t, h.gateway.reactionAdd.d),
      h.bridge.handleDispatch(h.gateway.threadCreate.t, h.gateway.threadCreate.d)
    ]);
    await h.bridge.idle();

    expect(actionNames(h)).toEqual(['messages.post', 'messages.edit', 'messages.react', 'channels.createThread']);
    expect(h.fake.actions[3]!.input).toMatchObject({ parentMessageId: 1001 });
  });

  test('a vanished local channel drops the link instead of erroring forever', async () => {
    const h = await linkedBridge();
    const gone = Object.assign(new Error('Channel not found'), { code: 'NOT_FOUND', name: 'PluginActionError' });
    h.fake.failNext('messages.post', gone);

    await h.dispatch(h.gateway.messageCreatePlain);
    expect(h.bridge.store.links.size).toBe(0);
    expect(h.fake.errors).toEqual([]);
  });

  test('an action failure is recorded on the link for the status card', async () => {
    const h = await linkedBridge();
    h.fake.failNext('messages.post', new Error('Message blocked by auto-moderation'));

    await h.dispatch(h.gateway.messageCreatePlain);
    expect((await h.call('status', { channelIds: [10] })).body).toMatchObject({
      links: { '10': { lastError: 'Message blocked by auto-moderation' } }
    });
  });
});

describe('outbound (here → remote)', () => {
  const sent = (h: TBridgeHarness) => h.transport.calls.find((c) => c.method === 'POST' && c.path.startsWith('/webhooks/'));

  test('a member\'s message goes out through the webhook with their name and avatar, mentions resolved, pings disabled', async () => {
    const h = await linkedBridge();

    await h.fake.emit('message:created', {
      messageId: 42,
      channelId: 10,
      userId: 7,
      content: '<p>Hello <@8> &amp; <@&3> <:pogchamp:1></p>'
    });

    expect(actionNames(h)).toEqual(['members.list']);
    const call = sent(h)!;
    expect(call.path).toBe(`/webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}`);
    expect(call.query).toEqual({ wait: 'true' });
    expect(call.headers.Authorization).toBeUndefined();
    expect(call.body).toEqual({
      content: 'Hello @Bob & @Raiders :pogchamp:',
      username: 'Ali',
      avatar_url: 'https://pulse.example/public/alice.png',
      allowed_mentions: { parse: [] }
    });
    expect(h.bridge.store.messageByLocal(42)).toEqual({
      localId: 42,
      remoteId: '520000000000000001',
      remoteChannelId: GENERAL,
      origin: 'out'
    });
    expect((await h.call('status', { channelIds: [10] })).body).toMatchObject({ links: { '10': { mirroredToday: 1 } } });
  });

  test('the bridge\'s own posts, an inbound-only link and unlinked channels send nothing', async () => {
    const h = await linkedBridge('inbound');

    await h.fake.emit('message:created', { messageId: 1, channelId: 10, userId: 7, content: 'x' });
    await h.fake.emit('message:created', { messageId: 2, channelId: 99, userId: 7, content: 'x' });
    expect(restCalls(h)).toEqual([]);

    const both = await linkedBridge();
    await both.fake.emit('message:created', { messageId: 3, channelId: 10, userId: 7, content: 'x', pluginId: PLUGIN_ID });
    await both.fake.emit('message:updated', { messageId: 3, channelId: 10, userId: 7, content: 'y', pluginId: PLUGIN_ID });
    await both.fake.emit('message:reaction', { messageId: 3, channelId: 10, userId: 7, emoji: '👍', added: true, pluginId: PLUGIN_ID });
    expect(restCalls(both)).toEqual([]);
  });

  test('replies carry a quoted first line; attachment links use the public address (fields read optionally)', async () => {
    const h = await linkedBridge();
    await h.dispatch(h.gateway.messageCreatePlain);
    h.transport.calls.length = 0;

    await h.fake.emit('message:created', {
      messageId: 43,
      channelId: 10,
      userId: 8,
      content: 'agreed',
      replyToId: 1001,
      attachments: [{ name: 'a.png', url: '/public/a.png' }, { name: 'b', url: 'https://files.example/b' }]
    } as never);

    expect(sent(h)!.body).toMatchObject({
      content: '> **Carol:** plain words\nagreed\nhttps://pulse.example/public/a.png\nhttps://files.example/b',
      username: 'Bob'
    });
    expect((sent(h)!.body as { avatar_url?: string }).avatar_url).toBeUndefined();
  });

  test('edits and deletions follow through the webhook message; a second delete is a no-op', async () => {
    const h = await linkedBridge();
    await h.fake.emit('message:created', { messageId: 42, channelId: 10, userId: 7, content: 'v1' });
    await h.fake.emit('message:updated', { messageId: 42, channelId: 10, userId: 7, content: '<p>v2</p>' });
    await h.fake.emit('message:deleted', { messageId: 42, channelId: 10 });
    await h.fake.emit('message:deleted', { messageId: 42, channelId: 10 });

    expect(restCalls(h)).toEqual([
      `POST /webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}`,
      `PATCH /webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}/messages/520000000000000001`,
      `DELETE /webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}/messages/520000000000000001`
    ]);
    expect(h.transport.calls[1]!.body).toEqual({ content: 'v2' });
    expect(h.bridge.store.messageByLocal(42)).toBeUndefined();
  });

  test('deleting the local copy of a remote message takes the original down with the bot', async () => {
    const h = await linkedBridge();
    await h.dispatch(h.gateway.messageCreatePlain);

    await h.fake.emit('message:deleted', { messageId: 1001, channelId: 10 });
    expect(restCalls(h)).toEqual([`DELETE /channels/${GENERAL}/messages/500000000000000002`]);
    expect(h.transport.calls[0]!.headers.Authorization).toBe('Bot bot-token');
  });

  test('reactions here become bot reactions there (unicode encoded, custom resolved through the guild, unknown dropped)', async () => {
    const h = await linkedBridge();
    await h.fake.emit('message:created', { messageId: 42, channelId: 10, userId: 7, content: 'v1' });
    h.transport.calls.length = 0;

    await h.fake.emit('message:reaction', { messageId: 42, channelId: 10, userId: 8, emoji: '👍', added: true });
    await h.fake.emit('message:reaction', { messageId: 42, channelId: 10, userId: 8, emoji: ':pogchamp:', added: true });
    await h.fake.emit('message:reaction', { messageId: 42, channelId: 10, userId: 8, emoji: ':unknown:', added: true });
    await h.fake.emit('message:reaction', { messageId: 42, channelId: 10, userId: 8, emoji: '👍', added: false });

    expect(restCalls(h)).toEqual([
      `PUT /channels/${GENERAL}/messages/520000000000000001/reactions/%F0%9F%91%8D/@me`,
      `PUT /channels/${GENERAL}/messages/520000000000000001/reactions/pogchamp:400000000000000001/@me`,
      `DELETE /channels/${GENERAL}/messages/520000000000000001/reactions/%F0%9F%91%8D/@me`
    ]);
  });

  test('a local thread opens a remote thread (from the mirrored starter when there is one) and its messages post into it', async () => {
    const h = await linkedBridge();
    await h.fake.emit('message:created', { messageId: 42, channelId: 10, userId: 7, content: 'starter' });
    h.transport.calls.length = 0;

    await h.fake.emit('thread:created', { threadId: 77, parentChannelId: 10, serverId: 1, name: 'local thread', creatorId: 7, parentMessageId: 42 });
    expect(restCalls(h)).toEqual([`POST /channels/${GENERAL}/messages/520000000000000001/threads`]);
    expect(h.transport.calls[0]!.body).toEqual({ name: 'local thread', auto_archive_duration: 1440 });
    expect(h.bridge.store.threads.get(77)?.remoteThreadId).toBe('560000000000000001');

    await h.fake.emit('message:created', { messageId: 43, channelId: 77, userId: 8, content: 'in thread' });
    expect(h.transport.calls[1]!.query).toEqual({ wait: 'true', thread_id: '560000000000000001' });

    await h.fake.emit('thread:created', { threadId: 78, parentChannelId: 10, serverId: 1, name: 'local thread 2', creatorId: 7 });
    expect(restCalls(h)[2]).toBe(`POST /channels/${GENERAL}/threads`);
    expect(h.transport.calls[2]!.body).toMatchObject({ type: 11 });

    await h.fake.emit('thread:created', { threadId: 79, parentChannelId: 10, serverId: 1, name: 'ours', creatorId: 1, pluginId: PLUGIN_ID });
    expect(restCalls(h)).toHaveLength(3);
  });

  test('a scheduled event here becomes one there; the echo of our own update is recognised; cancel deletes it', async () => {
    const h = await linkedBridge();
    const startsAt = Date.parse('2026-10-25T19:00:00Z');
    const endsAt = Date.parse('2026-10-25T21:00:00Z');

    await h.fake.emit('event:created', { eventId: 9, serverId: 1, title: 'Local raid', startsAt, endsAt, status: 'scheduled' });
    expect(restCalls(h)).toEqual([`POST /guilds/${GUILD}/scheduled-events`]);
    expect(h.transport.calls[0]!.body).toEqual({
      name: 'Local raid',
      privacy_level: 2,
      scheduled_start_time: '2026-10-25T19:00:00.000Z',
      scheduled_end_time: '2026-10-25T21:00:00.000Z',
      entity_type: 3,
      entity_metadata: { location: 'PULSE' }
    });
    expect(h.bridge.store.eventByLocal(9)?.remoteEventId).toBe('960000000000000001');

    // The gateway echoes our own creation (creator = bot) and update.
    await h.dispatch({ t: 'GUILD_SCHEDULED_EVENT_CREATE', d: { ...h.transport.calls[0]!.body as object, id: '960000000000000001', guild_id: GUILD, creator_id: '900000000000000001' } });
    await h.dispatch({
      t: 'GUILD_SCHEDULED_EVENT_UPDATE',
      d: { id: '960000000000000001', guild_id: GUILD, name: 'Local raid', scheduled_start_time: '2026-10-25T19:00:00.000Z', scheduled_end_time: '2026-10-25T21:00:00.000Z', status: 1 }
    });
    expect(h.fake.actions.filter((a) => a.name.startsWith('events.'))).toEqual([]);

    await h.fake.emit('event:updated', { eventId: 9, serverId: 1, title: 'Local raid (moved)', startsAt: startsAt + 3_600_000, endsAt: endsAt + 3_600_000, status: 'scheduled' });
    expect(restCalls(h)[1]).toBe(`PATCH /guilds/${GUILD}/scheduled-events/960000000000000001`);

    // A real change over there (different from what we pushed) is applied here.
    await h.dispatch({
      t: 'GUILD_SCHEDULED_EVENT_UPDATE',
      d: { id: '960000000000000001', guild_id: GUILD, name: 'Renamed there', scheduled_start_time: '2026-10-25T20:00:00.000Z', scheduled_end_time: '2026-10-25T22:00:00.000Z', status: 1 }
    });
    expect(h.fake.actions.find((a) => a.name === 'events.update')?.input).toMatchObject({ eventId: 9, patch: { title: 'Renamed there' } });
    expect(restCalls(h)).toHaveLength(2);

    await h.fake.emit('event:cancelled', { eventId: 9, serverId: 1, title: 'x', startsAt, endsAt, status: 'cancelled' });
    expect(restCalls(h)[2]).toBe(`DELETE /guilds/${GUILD}/scheduled-events/960000000000000001`);
    expect(h.bridge.store.eventByLocal(9)).toBeUndefined();
  });

  test('an edit queued behind a slow create still finds the remote id', async () => {
    const h = await linkedBridge();

    const create = h.fake.emit('message:created', { messageId: 42, channelId: 10, userId: 7, content: 'v1' });
    const edit = h.fake.emit('message:updated', { messageId: 42, channelId: 10, userId: 7, content: 'v2' });
    await Promise.all([create, edit]);

    expect(restCalls(h)).toEqual([
      `POST /webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}`,
      `PATCH /webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}/messages/520000000000000001`
    ]);
  });

  test('a webhook failure is recorded on the link and cleared by the next success', async () => {
    const h = await linkedBridge();
    h.transport.respond(`POST /webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}`, { status: 403, body: { message: 'Missing Access' } });

    await h.fake.emit('message:created', { messageId: 42, channelId: 10, userId: 7, content: 'v1' });
    expect((await h.call('status', { channelIds: [10] })).body).toMatchObject({
      links: { '10': { lastError: expect.stringContaining('Missing Access') } }
    });

    h.transport.respond(`POST /webhooks/${WEBHOOK}/${WEBHOOK_TOKEN}`, { status: 200, body: { id: '520000000000000009', channel_id: GENERAL } });
    await h.fake.emit('message:created', { messageId: 43, channelId: 10, userId: 7, content: 'v1' });
    expect((await h.call('status', { channelIds: [10] })).body).toMatchObject({ links: { '10': { lastError: null, mirroredToday: 1 } } });
  });
});
