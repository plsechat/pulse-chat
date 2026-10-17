import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair } from 'jose';
import { config } from '../../config';
import {
  PEER_DOMAIN,
  postSignedAsPeer,
  seedPeer
} from '../../__tests__/federation-fixtures';
import { createEmptyTextChannel } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { channelFollows, channels, messages, servers, users } from '../../db/schema';
import type { TAnnouncementRow } from '../../types';
import { pubsub } from '../../utils/pubsub';

/**
 * Receivers for the federated announcement follow:
 * /federation/announcement-follow (subscribe / unsubscribe on the
 * source's instance) and /federation/announcement (the copies on the
 * follower's instance). Signed like every relay; idempotent.
 */

config.federation.enabled = true;

afterEach(() => {
  mock.restore();
});

const systemRowsIn = async (channelId: number) => {
  const rows = await getTestDb()
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.type, 'system')));
  return rows.map((r) => ({ id: r.id, userId: r.userId, edited: r.edited, row: JSON.parse(r.content!) as TAnnouncementRow }));
};

/** A federatable server 1 with a public announcement channel. */
const announcementSource = async () => {
  const tdb = getTestDb();
  const { caller: owner } = await initTest(1);
  await tdb.update(servers).set({ federatable: true }).where(eq(servers.id, 1));
  const [server] = await tdb.select({ publicId: servers.publicId, name: servers.name }).from(servers).where(eq(servers.id, 1));
  const news = await createEmptyTextChannel('news');
  await owner.channels.update({ channelId: news.id, announcement: true });
  return { owner, server: server!, news };
};

describe('POST /federation/announcement-follow', () => {
  test('unsigned, badly signed and unknown-peer requests are refused', async () => {
    const { peerPrivateJwk } = await seedPeer();
    const { server, news } = await announcementSource();
    const body = {
      action: 'follow',
      serverPublicId: server.publicId,
      channelPublicId: news.publicId,
      targetChannelPublicId: 'their-digest'
    };

    const unsigned = await fetch(`${testsBaseUrl}/federation/announcement-follow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, fromDomain: PEER_DOMAIN })
    });
    expect(unsigned.status).toBe(400);

    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const wrongKey = await postSignedAsPeer('/federation/announcement-follow', body, await exportJWK(privateKey));
    expect(wrongKey.status).toBe(401);

    const stranger = await postSignedAsPeer('/federation/announcement-follow', body, peerPrivateJwk, 'stranger.example');
    expect(stranger.status).toBe(403);

    expect(await getTestDb().select().from(channelFollows)).toHaveLength(0);
  });

  test('follow records the remote follower once and answers with names; unfollow removes it', async () => {
    const { peerInstanceId, peerPrivateJwk } = await seedPeer();
    const { server, news } = await announcementSource();
    const spy = spyOn(pubsub, 'publishFor');
    const body = {
      action: 'follow',
      serverPublicId: server.publicId,
      channelPublicId: news.publicId,
      targetChannelPublicId: 'their-digest',
      targetChannelName: 'digest',
      targetServerName: 'Peer Server'
    };

    const first = await postSignedAsPeer('/federation/announcement-follow', body, peerPrivateJwk);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      success: true,
      sourceChannelName: 'news',
      sourceServerName: server.name,
      fromDomain: 'test.local'
    });
    expect(typeof first.body!.signature).toBe('string');

    const again = await postSignedAsPeer('/federation/announcement-follow', body, peerPrivateJwk);
    expect(again.status).toBe(200);
    expect(again.body!.success).toBe(true);

    const rows = await getTestDb().select().from(channelFollows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceChannelId: news.id,
      targetInstanceId: peerInstanceId,
      targetChannelPublicId: 'their-digest',
      targetChannelId: null
    });
    for (let i = 0; i < 100 && !spy.mock.calls.some(([, t]) => t === ServerEvents.CHANNEL_FOLLOWS_UPDATE); i++) await Bun.sleep(5);
    expect(spy.mock.calls.some(([, t, p]) => t === ServerEvents.CHANNEL_FOLLOWS_UPDATE && (p as { channelId: number }).channelId === news.id)).toBe(true);

    const gone = await postSignedAsPeer('/federation/announcement-follow', { ...body, action: 'unfollow' }, peerPrivateJwk);
    expect(gone.status).toBe(200);
    expect(await getTestDb().select().from(channelFollows)).toHaveLength(0);
    const repeat = await postSignedAsPeer('/federation/announcement-follow', { ...body, action: 'unfollow' }, peerPrivateJwk);
    expect(repeat.status).toBe(200);
  });

  test('not followable: wrong server id, private, not an announcement channel, server not federatable', async () => {
    const tdb = getTestDb();
    const { peerPrivateJwk } = await seedPeer();
    const { owner, server, news } = await announcementSource();
    const plain = await createEmptyTextChannel('plain');
    const follow = (overrides: Record<string, unknown>) =>
      postSignedAsPeer(
        '/federation/announcement-follow',
        {
          action: 'follow',
          serverPublicId: server.publicId,
          channelPublicId: news.publicId,
          targetChannelPublicId: 'their-digest',
          ...overrides
        },
        peerPrivateJwk
      );

    expect((await follow({ serverPublicId: 'other-server' })).body).toMatchObject({ ignored: 'not_followable' });
    expect((await follow({ channelPublicId: plain.publicId })).body).toMatchObject({ ignored: 'not_followable' });
    expect((await follow({ channelPublicId: 'no-such-channel' })).body).toMatchObject({ ignored: 'not_followable' });

    await owner.channels.update({ channelId: news.id, private: true });
    expect((await follow({})).body).toMatchObject({ ignored: 'not_followable' });
    await owner.channels.update({ channelId: news.id, private: false });

    await tdb.update(servers).set({ federatable: false }).where(eq(servers.id, 1));
    expect((await follow({})).body).toMatchObject({ ignored: 'not_followable' });

    expect((await follow({ action: 'subscribe' })).status).toBe(400);
    expect((await follow({ channelPublicId: 'x'.repeat(65) })).status).toBe(400);
    expect(await tdb.select().from(channelFollows)).toHaveLength(0);
  });

  test('removed: the source dropped us, so our follower row goes', async () => {
    const tdb = getTestDb();
    const { peerInstanceId, peerPrivateJwk } = await seedPeer();
    await initTest(1);
    const digest = await createEmptyTextChannel('digest');
    await tdb.insert(channelFollows).values({
      sourceInstanceId: peerInstanceId,
      sourceChannelPublicId: 'their-news',
      targetChannelId: digest.id,
      createdAt: Date.now()
    });

    const res = await postSignedAsPeer(
      '/federation/announcement-follow',
      { action: 'removed', channelPublicId: 'their-news', targetChannelPublicId: digest.publicId },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(await tdb.select().from(channelFollows)).toHaveLength(0);
  });
});

describe('POST /federation/announcement', () => {
  const announce = (overrides: Record<string, unknown>) => ({
    action: 'create',
    sourceServerPublicId: 'their-server',
    sourceServerName: 'Peer Server',
    sourceChannelPublicId: 'their-news',
    sourceChannelName: 'news',
    targetChannelPublicId: '',
    messageId: 41,
    content: 'Hello from the peer',
    edited: false,
    author: { publicId: 'remote-author', name: 'Remote Author', avatar: 'avatar-1.png' },
    ...overrides
  });

  const followerOf = async () => {
    const tdb = getTestDb();
    const { peerInstanceId, peerPrivateJwk } = await seedPeer();
    await initTest(1);
    const digest = await createEmptyTextChannel('digest');
    await tdb.insert(channelFollows).values({
      sourceInstanceId: peerInstanceId,
      sourceChannelPublicId: 'their-news',
      targetChannelId: digest.id,
      createdAt: Date.now()
    });
    return { peerInstanceId, peerPrivateJwk, digest };
  };

  test('create writes one copy (replay-safe) as a shadow author, update rewrites it, delete removes it', async () => {
    const tdb = getTestDb();
    const { peerInstanceId, peerPrivateJwk, digest } = await followerOf();
    const spy = spyOn(pubsub, 'publishFor');
    const body = announce({ targetChannelPublicId: digest.publicId });

    const first = await postSignedAsPeer('/federation/announcement', body, peerPrivateJwk);
    expect(first.status).toBe(200);
    expect(first.body!.success).toBe(true);
    const copyId = first.body!.messageId as number;

    const replay = await postSignedAsPeer('/federation/announcement', body, peerPrivateJwk);
    expect(replay.body!.messageId).toBe(copyId);

    const copies = await systemRowsIn(digest.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.row).toMatchObject({
      kind: 'announcement',
      sourceKey: `${PEER_DOMAIN}:their-news:41`,
      source: { domain: PEER_DOMAIN, serverPublicId: 'their-server', serverName: 'Peer Server', channelPublicId: 'their-news', channelName: 'news' },
      messageId: 41,
      content: 'Hello from the peer',
      author: { publicId: 'remote-author', name: 'Remote Author', avatarUrl: `https://${PEER_DOMAIN}/public/avatar-1.png` },
      edited: false
    });

    const [shadow] = await tdb.select().from(users).where(eq(users.id, copies[0]!.userId));
    expect(shadow).toMatchObject({ isFederated: true, federatedInstanceId: peerInstanceId, federatedPublicId: 'remote-author', name: 'Remote Author' });

    for (let i = 0; i < 100 && !spy.mock.calls.some(([, t]) => t === ServerEvents.NEW_MESSAGE); i++) await Bun.sleep(5);
    expect(spy.mock.calls.filter(([, t]) => t === ServerEvents.NEW_MESSAGE)).toHaveLength(1);

    const updated = await postSignedAsPeer(
      '/federation/announcement',
      { ...body, action: 'update', content: 'Hello again', edited: true },
      peerPrivateJwk
    );
    expect(updated.body!.success).toBe(true);
    const [afterUpdate] = await systemRowsIn(digest.id);
    expect(afterUpdate!.id).toBe(copyId);
    expect(afterUpdate!.row).toMatchObject({ content: 'Hello again', edited: true });
    expect(afterUpdate!.edited).toBe(true);

    const deleted = await postSignedAsPeer(
      '/federation/announcement',
      { action: 'delete', sourceChannelPublicId: 'their-news', targetChannelPublicId: digest.publicId, messageIds: [41, 42] },
      peerPrivateJwk
    );
    expect(deleted.body).toMatchObject({ success: true, removed: 1 });
    expect(await systemRowsIn(digest.id)).toHaveLength(0);
  });

  test('an update that arrives before its create still lands as a copy', async () => {
    const { peerPrivateJwk, digest } = await followerOf();

    const res = await postSignedAsPeer(
      '/federation/announcement',
      announce({ action: 'update', targetChannelPublicId: digest.publicId, content: 'edited first', edited: true }),
      peerPrivateJwk
    );
    expect(res.body!.success).toBe(true);
    const copies = await systemRowsIn(digest.id);
    expect(copies).toHaveLength(1);
    expect(copies[0]!.row).toMatchObject({ content: 'edited first', edited: true });
  });

  test('a peer we do not follow (or another channel) is ignored, never written', async () => {
    const tdb = getTestDb();
    const { peerPrivateJwk, digest } = await followerOf();
    const other = await createEmptyTextChannel('other');

    const wrongTarget = await postSignedAsPeer('/federation/announcement', announce({ targetChannelPublicId: other.publicId }), peerPrivateJwk);
    expect(wrongTarget.body).toMatchObject({ ignored: 'not_following' });
    const wrongSource = await postSignedAsPeer(
      '/federation/announcement',
      announce({ targetChannelPublicId: digest.publicId, sourceChannelPublicId: 'not-followed' }),
      peerPrivateJwk
    );
    expect(wrongSource.body).toMatchObject({ ignored: 'not_following' });

    // Another peer claiming the same source channel id is not the one we follow.
    await tdb.delete(channelFollows);
    const { peerPrivateJwk: otherKey } = await seedPeer('other.peer.example');
    await tdb.insert(channelFollows).values({
      sourceInstanceId: (await tdb.select().from(channels).where(eq(channels.id, digest.id)))[0] ? 1 : 1,
      sourceChannelPublicId: 'their-news',
      targetChannelId: digest.id,
      createdAt: Date.now()
    });
    const imposter = await postSignedAsPeer('/federation/announcement', announce({ targetChannelPublicId: digest.publicId }), otherKey, 'other.peer.example');
    expect(imposter.body).toMatchObject({ ignored: 'not_following' });

    expect(await systemRowsIn(digest.id)).toHaveLength(0);
    expect(await systemRowsIn(other.id)).toHaveLength(0);
  });

  test('structural bounds are 400: action, ids, message id, content, author, delete list', async () => {
    const { peerPrivateJwk, digest } = await followerOf();
    const post = (overrides: Record<string, unknown>) =>
      postSignedAsPeer('/federation/announcement', announce({ targetChannelPublicId: digest.publicId, ...overrides }), peerPrivateJwk);

    expect((await post({ action: 'publish' })).status).toBe(400);
    expect((await post({ sourceChannelPublicId: '' })).status).toBe(400);
    expect((await post({ messageId: '41' })).status).toBe(400);
    expect((await post({ messageId: 0 })).status).toBe(400);
    expect((await post({ content: 42 })).status).toBe(400);
    expect((await post({ content: 'x'.repeat(16001) })).status).toBe(400);
    expect((await post({ author: { publicId: '', name: 'x' } })).status).toBe(400);
    expect((await post({ author: { publicId: 'p', name: 7 } })).status).toBe(400);
    expect((await post({ action: 'delete', messageIds: [] })).status).toBe(400);
    expect((await post({ action: 'delete', messageIds: ['a'] })).status).toBe(400);
    expect((await post({ action: 'delete', messageIds: Array.from({ length: 101 }, (_, i) => i + 1) })).status).toBe(400);

    // A traversal-looking avatar name is dropped, the copy still lands.
    const ok = await post({ author: { publicId: 'p', name: 'x'.repeat(40), avatar: '../etc/passwd' } });
    expect(ok.status).toBe(200);
    const [copy] = await systemRowsIn(digest.id);
    expect(copy!.row.author.avatarUrl).toBeNull();
    expect(copy!.row.author.name).toHaveLength(32);
  });
});
