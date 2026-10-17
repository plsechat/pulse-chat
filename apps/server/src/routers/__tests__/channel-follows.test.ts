import { ChannelPermission, Permission, ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { config } from '../../config';
import {
  mockDns,
  seedPeer,
  spyOnFetch,
  TEST_LOCAL_DOMAIN
} from '../../__tests__/federation-fixtures';
import {
  createEmptyTextChannel,
  createTestChannel,
  createTestRole,
  createTestServerMember,
  grantTestUserRole,
  insertOtherServer
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import {
  channelFollows,
  channelUserPermissions,
  federationOutbox,
  messages
} from '../../db/schema';
import type { TAnnouncementRow } from '../../types';
import { _signChallengeAs } from '../../utils/federation';
import { pubsub } from '../../utils/pubsub';

/**
 * Following an announcement channel: a local follow copies posts (and
 * their edits / deletions) into the follower as announcement system
 * rows; a federated follow is recorded locally and relayed through the
 * outbox to the source's instance.
 */

const PEER = 'peer.follow.example.com';

type PublishCall = [number | number[], string, unknown];
const callsFor = (spy: { mock: { calls: unknown[][] } }, topic: string) =>
  (spy.mock.calls as PublishCall[]).filter(([, t]) => t === topic);

afterEach(() => {
  mock.restore();
  config.federation.enabled = false;
});

const copiesIn = async (channelId: number) => {
  const rows = await getTestDb()
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.type, 'system')));
  return rows.map((r) => ({ id: r.id, userId: r.userId, row: JSON.parse(r.content!) as TAnnouncementRow }));
};

/** Owner flags `news` as an announcement channel; `digest` follows it. */
const localPair = async () => {
  const { caller: owner } = await initTest(1);
  const news = await createEmptyTextChannel('news');
  const digest = await createEmptyTextChannel('digest');
  await owner.channels.update({ channelId: news.id, announcement: true });
  await owner.follows.follow({ channelId: digest.id, source: { kind: 'local', channelId: news.id } });
  return { owner, news, digest };
};

/** Copies are written after the send route returns; wait for them. */
const waitForCopies = async (channelId: number, count: number) => {
  for (let i = 0; i < 300; i++) {
    const copies = await copiesIn(channelId);
    if (copies.length >= count) return copies;
    await Bun.sleep(10);
  }
  return copiesIn(channelId);
};

describe('local follows', () => {
  test('follow lists both sides and refuses duplicates, self and non-announcement sources', async () => {
    const { owner, news, digest } = await localPair();

    const fromTarget = await owner.follows.list({ channelId: digest.id });
    expect(fromTarget.following).toHaveLength(1);
    expect(fromTarget.following[0]!.source).toMatchObject({ kind: 'local', channelId: news.id, channelName: 'news' });
    expect(fromTarget.following[0]!.target).toMatchObject({ kind: 'local', channelId: digest.id });
    expect(fromTarget.followers).toHaveLength(0);

    const fromSource = await owner.follows.list({ channelId: news.id });
    expect(fromSource.followers).toHaveLength(1);
    expect(fromSource.following).toHaveLength(0);
    // No federation: nothing to hand a peer.
    expect(fromSource.address).toBeNull();

    await expect(
      owner.follows.follow({ channelId: digest.id, source: { kind: 'local', channelId: news.id } })
    ).rejects.toThrow('already follows');
    await expect(
      owner.follows.follow({ channelId: news.id, source: { kind: 'local', channelId: news.id } })
    ).rejects.toThrow('cannot follow itself');
    const plain = await createEmptyTextChannel('plain');
    await expect(
      owner.follows.follow({ channelId: digest.id, source: { kind: 'local', channelId: plain.id } })
    ).rejects.toThrow('Only announcement channels');
  });

  test('a member without MANAGE_CHANNELS cannot follow, list or unfollow', async () => {
    const { news, digest } = await localPair();
    const { caller: member } = await initTest(2);

    await expect(
      member.follows.follow({ channelId: digest.id, source: { kind: 'local', channelId: news.id } })
    ).rejects.toThrow('Insufficient permissions');
    await expect(member.follows.list({ channelId: digest.id })).rejects.toThrow('Insufficient permissions');
    await expect(member.follows.unfollow({ followId: 1 })).rejects.toThrow('Insufficient permissions');
    await expect(member.follows.candidates()).rejects.toThrow('Insufficient permissions');
  });

  test('a new post is copied as an announcement row carrying content and author persona', async () => {
    const { owner, news, digest } = await localPair();
    const spy = spyOn(pubsub, 'publishFor');

    const id = await owner.messages.send({ channelId: news.id, content: 'Patch 1.2 is live' });
    const [copy] = await waitForCopies(digest.id, 1);

    expect(copy).toBeDefined();
    expect(copy!.userId).toBe(1);
    expect(copy!.row).toMatchObject({
      kind: 'announcement',
      sourceKey: `local:${news.id}:${id}`,
      source: { domain: null, channelName: 'news' },
      messageId: id,
      content: 'Patch 1.2 is live',
      author: { name: 'Test Owner', avatarUrl: null },
      edited: false
    });
    expect(copy!.row.source.serverPublicId.length).toBeGreaterThan(0);

    // The follower channel's viewers got the row as a new message.
    for (let i = 0; i < 100 && callsFor(spy, ServerEvents.NEW_MESSAGE).length < 2; i++) await Bun.sleep(5);
    const toDigest = callsFor(spy, ServerEvents.NEW_MESSAGE).find(
      (c) => (c[2] as { channelId: number }).channelId === digest.id
    );
    expect(toDigest).toBeDefined();
    expect((toDigest![2] as { type: string }).type).toBe('system');
  });

  test('polls, system rows and posts in non-announcement channels are not copied', async () => {
    const { owner, news, digest } = await localPair();
    const plain = await createEmptyTextChannel('plain');

    await owner.polls.create({ channelId: news.id, question: 'q', options: ['a', 'b'] });
    await owner.messages.send({ channelId: plain.id, content: 'not news' });
    await Bun.sleep(100);
    expect(await copiesIn(digest.id)).toHaveLength(0);
  });

  test('edits and deletions follow the source; reactions do not', async () => {
    const { owner, news, digest } = await localPair();
    const { caller: member } = await initTest(2);

    const id = await owner.messages.send({ channelId: news.id, content: 'v1' });
    const [copy] = await waitForCopies(digest.id, 1);

    await owner.messages.edit({ messageId: id, content: 'v2' });
    for (let i = 0; i < 200; i++) {
      const [c] = await copiesIn(digest.id);
      if (c?.row.content === 'v2') break;
      await Bun.sleep(10);
    }
    const [edited] = await copiesIn(digest.id);
    expect(edited!.id).toBe(copy!.id);
    expect(edited!.row).toMatchObject({ content: 'v2', edited: true });
    const [editedRow] = await getTestDb().select().from(messages).where(eq(messages.id, copy!.id));
    expect(editedRow!.edited).toBe(true);

    await member.messages.toggleReaction({ messageId: id, emoji: '🎉' });
    const { messages: digestMessages } = await owner.messages.get({ channelId: digest.id });
    expect(digestMessages.find((m) => m.id === copy!.id)!.reactions).toEqual([]);

    const spy = spyOn(pubsub, 'publishFor');
    await owner.messages.delete({ messageId: id });
    for (let i = 0; i < 200 && (await copiesIn(digest.id)).length > 0; i++) await Bun.sleep(10);
    expect(await copiesIn(digest.id)).toHaveLength(0);
    const deletions = callsFor(spy, ServerEvents.MESSAGE_DELETE).map((c) => c[2] as { channelId: number });
    expect(deletions.some((d) => d.channelId === digest.id)).toBe(true);
  });

  test('bulk delete and purge remove the copies too', async () => {
    const { owner, news, digest } = await localPair();
    const a = await owner.messages.send({ channelId: news.id, content: 'a' });
    const b = await owner.messages.send({ channelId: news.id, content: 'b' });
    const c = await owner.messages.send({ channelId: news.id, content: 'c' });
    await waitForCopies(digest.id, 3);

    await owner.messages.bulkDelete({ messageIds: [a, b] });
    for (let i = 0; i < 200 && (await copiesIn(digest.id)).length > 1; i++) await Bun.sleep(10);
    expect((await copiesIn(digest.id)).map((x) => x.row.messageId)).toEqual([c]);

    await owner.messages.purge({ channelId: news.id, confirmChannelName: 'news' });
    for (let i = 0; i < 200 && (await copiesIn(digest.id)).length > 0; i++) await Bun.sleep(10);
    expect(await copiesIn(digest.id)).toHaveLength(0);
  });

  test('unfollow removes the relation only: copies stay, new posts stop', async () => {
    const { owner, news, digest } = await localPair();
    await owner.messages.send({ channelId: news.id, content: 'before' });
    await waitForCopies(digest.id, 1);

    const { following } = await owner.follows.list({ channelId: digest.id });
    const spy = spyOn(pubsub, 'publishFor');
    await owner.follows.unfollow({ followId: following[0]!.id });
    expect(await getTestDb().select().from(channelFollows)).toHaveLength(0);
    for (let i = 0; i < 100 && callsFor(spy, ServerEvents.CHANNEL_FOLLOWS_UPDATE).length < 2; i++) await Bun.sleep(5);
    expect(callsFor(spy, ServerEvents.CHANNEL_FOLLOWS_UPDATE).map((c) => c[2])).toEqual(
      expect.arrayContaining([{ channelId: digest.id }, { channelId: news.id }])
    );

    await owner.messages.send({ channelId: news.id, content: 'after' });
    await Bun.sleep(100);
    const copies = await copiesIn(digest.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.row.content).toBe('before');

    await expect(owner.follows.unfollow({ followId: following[0]!.id })).rejects.toThrow('Follow not found');
  });

  test('cross-server: candidates list what the caller can view; following needs VIEW on the source', async () => {
    const tdb = getTestDb();
    const { caller: owner } = await initTest(1);
    const other = await insertOtherServer();
    await createTestServerMember({ serverId: other.id, userId: 1 });
    const visible = await createTestChannel({ serverId: other.id, name: 'other-news' });
    const hidden = await createTestChannel({ serverId: other.id, name: 'hidden-news' });
    const { channels } = await import('../../db/schema');
    await tdb.update(channels).set({ announcement: true }).where(eq(channels.id, visible));
    await tdb.update(channels).set({ announcement: true, private: true }).where(eq(channels.id, hidden));
    const home = await createEmptyTextChannel('home-news');
    await owner.channels.update({ channelId: home.id, announcement: true });

    const candidates = await owner.follows.candidates();
    expect(candidates.map((c) => c.channelName).sort()).toEqual(['home-news', 'other-news']);
    expect(candidates.find((c) => c.channelName === 'other-news')!.serverName).toBe(other.name);

    const digest = await createEmptyTextChannel('digest');
    await expect(
      owner.follows.follow({ channelId: digest.id, source: { kind: 'local', channelId: hidden } })
    ).rejects.toThrow('Source channel not found');
    await owner.follows.follow({ channelId: digest.id, source: { kind: 'local', channelId: visible } });

    // An override that grants VIEW on the private one makes it a candidate.
    await tdb.insert(channelUserPermissions).values({
      channelId: hidden,
      userId: 1,
      permission: ChannelPermission.VIEW_CHANNEL,
      allow: true,
      createdAt: Date.now()
    });
    expect((await owner.follows.candidates()).map((c) => c.channelName)).toContain('hidden-news');

    // Not a member of the other server any more: nothing from it.
    const { serverMembers } = await import('../../db/schema');
    await tdb.delete(serverMembers).where(and(eq(serverMembers.serverId, other.id), eq(serverMembers.userId, 1)));
    expect((await owner.follows.candidates()).map((c) => c.channelName)).toEqual(['home-news']);
  });

  test('the target must be a text channel of the active server', async () => {
    const { owner, news } = await localPair();
    const other = await insertOtherServer();
    const foreign = await createTestChannel({ serverId: other.id });
    const { ChannelType } = await import('@pulse/shared');
    const voice = await createTestChannel({ serverId: 1, type: ChannelType.VOICE });

    await expect(
      owner.follows.follow({ channelId: foreign, source: { kind: 'local', channelId: news.id } })
    ).rejects.toThrow('Channel not found');
    await expect(
      owner.follows.follow({ channelId: voice, source: { kind: 'local', channelId: news.id } })
    ).rejects.toThrow('Only text channels');
  });

  test('a MANAGE_CHANNELS role (not the owner) can manage follows', async () => {
    const role = await createTestRole({ serverId: 1, permissions: [Permission.MANAGE_CHANNELS] });
    await grantTestUserRole(2, role);
    const { caller: owner } = await initTest(1);
    const news = await createEmptyTextChannel('news');
    await owner.channels.update({ channelId: news.id, announcement: true });
    const { caller: manager } = await initTest(2);
    const digest = await createEmptyTextChannel('digest');

    await manager.follows.follow({ channelId: digest.id, source: { kind: 'local', channelId: news.id } });
    const { following } = await manager.follows.list({ channelId: digest.id });
    expect(following).toHaveLength(1);
    await manager.follows.unfollow({ followId: following[0]!.id });
  });
});

describe('federated follows', () => {
  test('a remote source is recorded, relayed, and refused when the peer says so', async () => {
    const tdb = getTestDb();
    const { peerInstanceId, peerPrivateJwk } = await seedPeer(PEER);
    config.federation.enabled = true;
    mockDns();
    const { caller: owner } = await initTest(1);
    const digest = await createEmptyTextChannel('digest');

    // Peer confirms: the row stays, status 'following'.
    const signedOk = async (call: { url: string }) => {
      const payload = { success: true, sourceChannelName: 'news', sourceServerName: 'Peer', fromDomain: PEER };
      const signature = await _signChallengeAs(payload, PEER, TEST_LOCAL_DOMAIN, peerPrivateJwk);
      expect(call.url).toContain('/federation/announcement-follow');
      return new Response(JSON.stringify({ ...payload, signature }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };
    const { calls } = spyOnFetch(signedOk);

    const result = await owner.follows.follow({
      channelId: digest.id,
      source: { kind: 'remote', address: `${PEER}/server-pub/chan-pub` }
    });
    expect(result).toEqual({ status: 'following' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({
      action: 'follow',
      serverPublicId: 'server-pub',
      channelPublicId: 'chan-pub',
      targetChannelPublicId: digest.publicId,
      targetChannelName: 'digest',
      fromDomain: TEST_LOCAL_DOMAIN
    });

    const rows = await tdb.select().from(channelFollows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceInstanceId: peerInstanceId,
      sourceChannelPublicId: 'chan-pub',
      targetChannelId: digest.id,
      sourceChannelId: null
    });
    const { following } = await owner.follows.list({ channelId: digest.id });
    expect(following[0]!.source).toMatchObject({ kind: 'remote', domain: PEER, channelPublicId: 'chan-pub' });

    await expect(
      owner.follows.follow({ channelId: digest.id, source: { kind: 'remote', address: `${PEER}/server-pub/chan-pub` } })
    ).rejects.toThrow('already follows');

    // Peer refuses: the row is rolled back and the caller told.
    mock.restore();
    mockDns();
    spyOnFetch(async () => {
      const payload = { ignored: 'not_followable', fromDomain: PEER };
      const signature = await _signChallengeAs(payload, PEER, TEST_LOCAL_DOMAIN, peerPrivateJwk);
      return new Response(JSON.stringify({ ...payload, signature }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    });
    const second = await createEmptyTextChannel('digest-2');
    await expect(
      owner.follows.follow({ channelId: second.id, source: { kind: 'remote', address: `${PEER}/server-pub/private-chan` } })
    ).rejects.toThrow('cannot be followed');
    expect(await tdb.select().from(channelFollows)).toHaveLength(1);
  });

  test('the follow address is offered for a public announcement channel of a federatable server', async () => {
    const tdb = getTestDb();
    config.federation.enabled = true;
    const { caller: owner } = await initTest(1);
    const news = await createEmptyTextChannel('news');
    await owner.channels.update({ channelId: news.id, announcement: true });

    expect((await owner.follows.list({ channelId: news.id })).address).toBeNull();

    const { servers } = await import('../../db/schema');
    await tdb.update(servers).set({ federatable: true }).where(eq(servers.id, 1));
    const [server] = await tdb.select({ publicId: servers.publicId }).from(servers).where(eq(servers.id, 1));
    expect((await owner.follows.list({ channelId: news.id })).address).toBe(
      `${TEST_LOCAL_DOMAIN}/${server!.publicId}/${news.publicId}`
    );

    await owner.channels.update({ channelId: news.id, private: true });
    expect((await owner.follows.list({ channelId: news.id })).address).toBeNull();
  });

  test('a peer that is down leaves the follow pending in the outbox', async () => {
    const tdb = getTestDb();
    await seedPeer(PEER);
    config.federation.enabled = true;
    mockDns();
    spyOnFetch(() => new Response('', { status: 503 }));
    const { caller: owner } = await initTest(1);
    const digest = await createEmptyTextChannel('digest');

    const result = await owner.follows.follow({
      channelId: digest.id,
      source: { kind: 'remote', address: `https://${PEER}/server-pub/chan-pub` }
    });
    expect(result).toEqual({ status: 'pending' });
    expect(await tdb.select().from(channelFollows)).toHaveLength(1);
    // The queued retry is detached from the click; wait for its row.
    let outbox = await tdb.select().from(federationOutbox);
    for (let i = 0; i < 200 && outbox.length === 0; i++) {
      await Bun.sleep(10);
      outbox = await tdb.select().from(federationOutbox);
    }
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.path).toBe('/federation/announcement-follow');
    expect(outbox[0]!.deadAt).toBeNull();
  });

  test('address validation, unknown peers and federation-off are refused', async () => {
    const { caller: owner } = await initTest(1);
    const digest = await createEmptyTextChannel('digest');
    const remote = (address: string) =>
      owner.follows.follow({ channelId: digest.id, source: { kind: 'remote', address } });

    await expect(remote(`${PEER}/a/b`)).rejects.toThrow('Federation is not enabled');

    config.federation.enabled = true;
    await expect(remote('not an address')).rejects.toThrow('domain/server-id/channel-id');
    await expect(remote('peer.example/only-two')).rejects.toThrow('domain/server-id/channel-id');
    await expect(remote(`${PEER}/${'x'.repeat(65)}/b`)).rejects.toThrow('domain/server-id/channel-id');
    await expect(remote(`${TEST_LOCAL_DOMAIN}/a/b`)).rejects.toThrow('Pick the channel from the list');
    await expect(remote('unknown.example.com/a/b')).rejects.toThrow('not a federation peer');
    await expect(remote('x'.repeat(400))).rejects.toThrow();
  });

  test('a post reaches a remote follower through the outbox; unfollow tells the source', async () => {
    const tdb = getTestDb();
    const { peerInstanceId } = await seedPeer(PEER);
    config.federation.enabled = true;
    mockDns();
    const { calls } = spyOnFetch();
    const { caller: owner } = await initTest(1);
    const news = await createEmptyTextChannel('news');
    await owner.channels.update({ channelId: news.id, announcement: true });
    // The peer's follower, as its /federation/announcement-follow would record it.
    await tdb.insert(channelFollows).values({
      sourceChannelId: news.id,
      targetInstanceId: peerInstanceId,
      targetChannelPublicId: 'remote-digest',
      createdAt: Date.now()
    });

    const id = await owner.messages.send({ channelId: news.id, content: 'hello peers' });
    for (let i = 0; i < 200 && calls.length < 1; i++) await Bun.sleep(10);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://${PEER}/federation/announcement`);
    expect(calls[0]!.body).toMatchObject({
      action: 'create',
      sourceChannelPublicId: news.publicId,
      sourceChannelName: 'news',
      targetChannelPublicId: 'remote-digest',
      messageId: id,
      content: 'hello peers',
      edited: false,
      author: { name: 'Test Owner', avatar: null },
      relayId: `create:${news.publicId}:${id}:0`
    });
    expect(typeof (calls[0]!.body.author as { publicId: string }).publicId).toBe('string');
    // Delivered inline: nothing left queued.
    expect(await tdb.select().from(federationOutbox)).toHaveLength(0);

    await owner.messages.edit({ messageId: id, content: 'hello peers (edited)' });
    for (let i = 0; i < 200 && calls.length < 2; i++) await Bun.sleep(10);
    expect(calls[1]!.body).toMatchObject({ action: 'update', content: 'hello peers (edited)', edited: true });

    await owner.messages.delete({ messageId: id });
    for (let i = 0; i < 200 && calls.length < 3; i++) await Bun.sleep(10);
    expect(calls[2]!.body).toMatchObject({ action: 'delete', messageIds: [id], targetChannelPublicId: 'remote-digest' });

    // The source drops the remote follower: the peer is told.
    const { followers } = await owner.follows.list({ channelId: news.id });
    expect(followers[0]!.target).toMatchObject({ kind: 'remote', domain: PEER, channelPublicId: 'remote-digest' });
    await owner.follows.unfollow({ followId: followers[0]!.id });
    for (let i = 0; i < 200 && calls.length < 4; i++) await Bun.sleep(10);
    expect(calls[3]!.url).toBe(`https://${PEER}/federation/announcement-follow`);
    expect(calls[3]!.body).toMatchObject({ action: 'removed', channelPublicId: news.publicId, targetChannelPublicId: 'remote-digest' });
    expect(await tdb.select().from(channelFollows)).toHaveLength(0);
  });

  test('unfollowing a remote source relays the unfollow to its instance', async () => {
    const tdb = getTestDb();
    const { peerInstanceId } = await seedPeer(PEER);
    config.federation.enabled = true;
    mockDns();
    const { calls } = spyOnFetch();
    const { caller: owner } = await initTest(1);
    const digest = await createEmptyTextChannel('digest');
    const [row] = await tdb
      .insert(channelFollows)
      .values({
        sourceInstanceId: peerInstanceId,
        sourceChannelPublicId: 'chan-pub',
        targetChannelId: digest.id,
        createdAt: Date.now()
      })
      .returning();

    await owner.follows.unfollow({ followId: row!.id });
    for (let i = 0; i < 200 && calls.length < 1; i++) await Bun.sleep(10);
    expect(calls[0]!.body).toMatchObject({
      action: 'unfollow',
      channelPublicId: 'chan-pub',
      targetChannelPublicId: digest.publicId
    });
    expect(await tdb.select().from(channelFollows)).toHaveLength(0);
  });
});
