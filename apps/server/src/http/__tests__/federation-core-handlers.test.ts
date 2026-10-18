/**
 * The v0.1-era inbound federation routes — dm-relay, friend-request /
 * friend-accept / friend-remove, user-info, request, accept, servers —
 * now on the shared `authorizeFederationRequest` prologue.
 *
 * Each test fabricates a signed request as if it came from a peer
 * (`postSignedAsPeer`), posts it to the test HTTP server, and asserts
 * on the response, persisted rows and pubsub events. Outbound calls a
 * handler makes (reverse /federation/info fetches, third-instance
 * attestation) are stubbed with `spyOnFetch`, which lets the post to
 * the local server through.
 *
 * Setup is inline per test (no beforeEach — it deadlocks against the
 * global TRUNCATE).
 */

import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, type JWK } from 'jose';
import { config } from '../../config';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  dmMessages,
  federationInstances,
  friendRequests,
  friendships,
  serverMembers,
  servers,
  userBlocks,
  users
} from '../../db/schema';
import {
  mockDns,
  PEER_DOMAIN,
  postSignedAsPeer,
  seedPeer,
  spyOnFetch,
  TEST_LOCAL_DOMAIN
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { testsBaseUrl } from '../../__tests__/setup';
import { _signChallengeAs, getLocalKeys } from '../../utils/federation';
import { pubsub } from '../../utils/pubsub';

config.federation.enabled = true;

afterEach(() => {
  mock.restore();
});

const THIRD_DOMAIN = 'third.example';

async function getUserPublicId(userId: number): Promise<string> {
  const [u] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u!.publicId!;
}

async function shadowFor(
  instanceId: number,
  federatedPublicId: string
): Promise<{ id: number; name: string } | undefined> {
  const [row] = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.federatedInstanceId, instanceId),
        eq(users.federatedPublicId, federatedPublicId)
      )
    )
    .limit(1);
  return row;
}

async function seedShadow(
  instanceId: number,
  federatedPublicId: string,
  name = federatedPublicId
): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      supabaseId: `federated-${federatedPublicId}`,
      name,
      publicId: `local-${federatedPublicId}`,
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId,
      createdAt: Date.now()
    })
    .returning({ id: users.id });
  return row!.id;
}

const befriend = (a: number, b: number) =>
  db.insert(friendships).values({ userId: a, friendId: b, createdAt: Date.now() });

const block = (blocker: number, blocked: number) =>
  db
    .insert(userBlocks)
    .values({ blockerId: blocker, blockedUserId: blocked, createdAt: Date.now() });

const joinServer1 = (userId: number) =>
  db.insert(serverMembers).values({ serverId: 1, userId, joinedAt: Date.now() });

function withPubsubSpy<T>(
  fn: (events: { topic: string; payload: unknown }[]) => Promise<T>
): Promise<T> {
  const events: { topic: string; payload: unknown }[] = [];
  const original = pubsub.publishFor.bind(pubsub);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pubsub as any).publishFor = (
    userIds: unknown,
    topic: string,
    payload: unknown
  ) => {
    events.push({ topic, payload });
    return original(userIds as never, topic as never, payload as never);
  };
  const restore = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publishFor = original;
  };
  return fn(events).finally(restore);
}

const relayBody = (toPublicId: string, extra: Record<string, unknown> = {}) => ({
  fromUsername: 'Remote',
  fromPublicId: 'remote-sender-pid',
  fromUserId: 7,
  toPublicId,
  content: 'hello from afar',
  ...extra
});

const messagesIn = (channelId: number) =>
  db.select().from(dmMessages).where(eq(dmMessages.dmChannelId, channelId));

describe('POST /federation/dm-relay', () => {
  test('friend: first message mints the pair-keyed 1:1 channel, stores the message and rings once', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await befriend(1, shadowId);

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/dm-relay',
        relayBody(localPublicId, { relayId: 'relay-1' }),
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      expect(res.body?.success).toBe(true);

      const channels = await db.select().from(dmChannels);
      expect(channels).toHaveLength(1);
      expect(channels[0]!.isGroup).toBe(false);
      expect(channels[0]!.pairKey).toMatch(/^federated:peer\.example:remote-sender-pid\|local:/);
      const members = await db
        .select({ userId: dmChannelMembers.userId })
        .from(dmChannelMembers)
        .where(eq(dmChannelMembers.dmChannelId, channels[0]!.id));
      expect(members.map((m) => m.userId).sort()).toEqual([1, shadowId].sort());

      const msgs = await messagesIn(channels[0]!.id);
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.userId).toBe(shadowId);
      expect(msgs[0]!.content).toBe('hello from afar');
      expect(msgs[0]!.federationRelayId).toBe('relay-1');
      // The sender's numeric id is informational only.
      const [shadow] = await db
        .select({ federatedUsername: users.federatedUsername })
        .from(users)
        .where(eq(users.id, shadowId));
      expect(shadow!.federatedUsername).toBe('7');

      expect(events.filter((e) => e.topic === ServerEvents.DM_CHANNEL_UPDATE)).toHaveLength(1);
      expect(events.filter((e) => e.topic === ServerEvents.DM_NEW_MESSAGE)).toHaveLength(1);
    });
  });

  test('shared server (no friendship) also permits first contact', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await joinServer1(shadowId);

    const res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId),
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    expect(await db.select().from(dmChannels)).toHaveLength(1);
  });

  test('stranger: no friendship and no shared server → 200 ignored, nothing stored, nothing rung', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/dm-relay',
        relayBody(localPublicId),
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      expect(res.body?.ignored).toBe('not_permitted');
      expect(await db.select().from(dmChannels)).toHaveLength(0);
      expect(await db.select().from(dmMessages)).toHaveLength(0);
      expect(events).toHaveLength(0);
    });
  });

  test('an existing channel keeps flowing without a friendship or shared server', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await befriend(1, shadowId);

    let res = await postSignedAsPeer('/federation/dm-relay', relayBody(localPublicId), peerPrivateJwk);
    expect(res.status).toBe(200);
    // Unfriend: the conversation that exists is still theirs to continue.
    await db.delete(friendships);

    res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId, { content: 'still here' }),
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    const channels = await db.select().from(dmChannels);
    expect(channels).toHaveLength(1);
    expect(await messagesIn(channels[0]!.id)).toHaveLength(2);
  });

  test('blocked in either direction → 200 ignored, no row, no ring', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await befriend(1, shadowId);
    await block(1, shadowId);

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/dm-relay',
        relayBody(localPublicId),
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      expect(res.body?.ignored).toBe('blocked');
      expect(await db.select().from(dmMessages)).toHaveLength(0);
      expect(events).toHaveLength(0);
    });

    // The shadow blocking the local user is just as final.
    await db.delete(userBlocks);
    await block(shadowId, 1);
    const res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId),
      peerPrivateJwk
    );
    expect(res.body?.ignored).toBe('blocked');
  });

  test('a retried relayId lands once and does not ring again', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await befriend(1, shadowId);

    await withPubsubSpy(async (events) => {
      const first = await postSignedAsPeer(
        '/federation/dm-relay',
        relayBody(localPublicId, { relayId: 'relay-dup' }),
        peerPrivateJwk
      );
      expect(first.status).toBe(200);
      const second = await postSignedAsPeer(
        '/federation/dm-relay',
        relayBody(localPublicId, { relayId: 'relay-dup' }),
        peerPrivateJwk
      );
      expect(second.status).toBe(200);
      expect(second.body?.duplicate).toBe(true);
      expect(second.body?.messageId).toBe(first.body?.messageId);

      expect(await db.select().from(dmMessages)).toHaveLength(1);
      expect(events.filter((e) => e.topic === ServerEvents.DM_NEW_MESSAGE)).toHaveLength(1);
    });
  });

  test('two first messages racing on the same pair land on one channel', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await befriend(1, shadowId);

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        postSignedAsPeer(
          '/federation/dm-relay',
          relayBody(localPublicId, { relayId: `race-${i}`, content: `m${i}` }),
          peerPrivateJwk
        )
      )
    );
    expect(results.every((r) => r.status === 200 && r.body?.success === true)).toBe(true);

    const channels = await db.select().from(dmChannels);
    expect(channels).toHaveLength(1);
    expect(await messagesIn(channels[0]!.id)).toHaveLength(4);
  });

  test('an encrypted envelope flips an existing plaintext channel to e2ee (one way)', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await befriend(1, shadowId);

    await postSignedAsPeer('/federation/dm-relay', relayBody(localPublicId), peerPrivateJwk);
    let [channel] = await db.select().from(dmChannels);
    expect(channel!.e2ee).toBe(false);

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/dm-relay',
        relayBody(localPublicId, { content: 'ciphertext', e2ee: true }),
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      [channel] = await db.select().from(dmChannels);
      expect(channel!.e2ee).toBe(true);
      expect(events.filter((e) => e.topic === ServerEvents.DM_CHANNEL_UPDATE)).toHaveLength(1);
    });

    // Plaintext after the flip does not turn encryption back off.
    await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId, { content: 'plain again' }),
      peerPrivateJwk
    );
    [channel] = await db.select().from(dmChannels);
    expect(channel!.e2ee).toBe(true);
    const msgs = await messagesIn(channel!.id);
    expect(msgs.map((m) => m.e2ee)).toEqual([false, true, false]);
  });

  test('group: routes into the announced mirror; an unannounced group is a retryable 409', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const announce = await postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId: 'fed-group-relay',
        name: 'Relay Group',
        ownerPublicId: 'remote-sender-pid',
        members: [
          { publicId: 'remote-sender-pid', instanceDomain: PEER_DOMAIN, name: 'Remote' },
          { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' }
        ]
      },
      peerPrivateJwk
    );
    expect(announce.status).toBe(200);
    const mirrorId = announce.body?.dmChannelId as number;

    let res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId, { federationGroupId: 'fed-group-relay' }),
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(await messagesIn(mirrorId)).toHaveLength(1);
    // No 1:1 channel was minted on the side.
    expect(await db.select().from(dmChannels)).toHaveLength(1);

    res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId, { federationGroupId: 'fed-group-never-announced' }),
      peerPrivateJwk
    );
    expect(res.status).toBe(409);

    // A sender the peer removed from the group still knows the id.
    const shadow = (await shadowFor(peerInstanceId, 'remote-sender-pid'))!;
    await db
      .delete(dmChannelMembers)
      .where(
        and(
          eq(dmChannelMembers.dmChannelId, mirrorId),
          eq(dmChannelMembers.userId, shadow.id)
        )
      );
    res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId, { federationGroupId: 'fed-group-relay' }),
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.ignored).toBe('not_member');
    expect(await messagesIn(mirrorId)).toHaveLength(1);
  });

  test('unknown recipient → 200 ignored (no existence leak, no retry)', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody('no-such-user'),
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.ignored).toBe('unknown_recipient');
  });

  test('rejects unsigned requests and requests signed with an unknown key', async () => {
    await initTest();
    await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const unsigned = await fetch(`${testsBaseUrl}/federation/dm-relay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDomain: PEER_DOMAIN, ...relayBody(localPublicId) })
    });
    expect(unsigned.status).toBe(400);

    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const forged = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId),
      await exportJWK(privateKey)
    );
    expect(forged.status).toBe(401);
    expect(await db.select().from(dmMessages)).toHaveLength(0);
  });

  test('a malformed fromAvatarFile is dropped rather than fetched', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-sender-pid');
    await befriend(1, shadowId);
    mockDns();
    const { calls } = spyOnFetch();

    const res = await postSignedAsPeer(
      '/federation/dm-relay',
      relayBody(localPublicId, { fromAvatarFile: '../../etc/passwd' }),
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.url.includes('/public/'))).toHaveLength(0);
  });
});

describe('POST /federation/friend-request / friend-accept / friend-remove', () => {
  test('round trip: request lands as pending, acceptance by the local side is mirrored back, removal clears it', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/friend-request',
        {
          fromUsername: 'Remote',
          fromPublicId: 'remote-friend-pid',
          fromUserId: 12,
          toPublicId: localPublicId
        },
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      const shadow = (await shadowFor(peerInstanceId, 'remote-friend-pid'))!;
      expect(shadow.name).toBe('Remote');
      const pending = await db.select().from(friendRequests);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ senderId: shadow.id, receiverId: 1, status: 'pending' });
      expect(events.filter((e) => e.topic === ServerEvents.FRIEND_REQUEST_RECEIVED)).toHaveLength(1);
    });

    // The local user sent a request the OTHER way; the peer's user accepts.
    const shadow = (await shadowFor(peerInstanceId, 'remote-friend-pid'))!;
    await db.delete(friendRequests);
    await db.insert(friendRequests).values({
      senderId: 1,
      receiverId: shadow.id,
      status: 'pending',
      createdAt: Date.now()
    });
    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/friend-accept',
        { fromUsername: 'Remote', fromPublicId: 'remote-friend-pid', toPublicId: localPublicId },
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      expect(res.body?.success).toBe(true);
      const [req] = await db.select().from(friendRequests);
      expect(req!.status).toBe('accepted');
      expect(await db.select().from(friendships)).toHaveLength(1);
      expect(events.filter((e) => e.topic === ServerEvents.FRIEND_REQUEST_ACCEPTED)).toHaveLength(1);

      // A retried acceptance is a no-op, not a second friendship.
      const again = await postSignedAsPeer(
        '/federation/friend-accept',
        { fromUsername: 'Remote', fromPublicId: 'remote-friend-pid', toPublicId: localPublicId },
        peerPrivateJwk
      );
      expect(again.status).toBe(200);
      expect(again.body?.ignored).toBe('no_pending_request');
      expect(await db.select().from(friendships)).toHaveLength(1);
    });

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/friend-remove',
        { fromPublicId: 'remote-friend-pid', toPublicId: localPublicId },
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      expect(await db.select().from(friendships)).toHaveLength(0);
      expect(events.filter((e) => e.topic === ServerEvents.FRIEND_REMOVED)).toHaveLength(1);
    });
  });

  test('friend-request: a block drops the request without disclosing it', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    const shadowId = await seedShadow(peerInstanceId, 'remote-friend-pid');
    await block(1, shadowId);

    await withPubsubSpy(async (events) => {
      const res = await postSignedAsPeer(
        '/federation/friend-request',
        { fromUsername: 'Remote', fromPublicId: 'remote-friend-pid', toPublicId: localPublicId },
        peerPrivateJwk
      );
      expect(res.status).toBe(200);
      expect(res.body?.ignored).toBe('blocked');
      expect(await db.select().from(friendRequests)).toHaveLength(0);
      expect(events).toHaveLength(0);
    });
  });

  test('friend-remove only acts for shadows homed on the authenticated peer', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const { peerInstanceId: thirdId } = await seedPeer(THIRD_DOMAIN);
    const localPublicId = await getUserPublicId(1);
    const thirdShadow = await seedShadow(thirdId, 'remote-friend-pid');
    await befriend(1, thirdShadow);

    const res = await postSignedAsPeer(
      '/federation/friend-remove',
      { fromPublicId: 'remote-friend-pid', toPublicId: localPublicId },
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.ignored).toBe('unknown_user');
    expect(await db.select().from(friendships)).toHaveLength(1);
  });

  test('requires both publicIds and rejects unsigned requests', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer(
      '/federation/friend-request',
      { fromUsername: 'Remote', toPublicId: 'x' },
      peerPrivateJwk
    );
    expect(res.status).toBe(400);

    const unsigned = await fetch(`${testsBaseUrl}/federation/friend-remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDomain: PEER_DOMAIN, fromPublicId: 'a', toPublicId: 'b' })
    });
    expect(unsigned.status).toBe(400);
  });
});

describe('POST /federation/user-info', () => {
  test('answers a signed profile for a local user by publicId', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    const res = await postSignedAsPeer('/federation/user-info', { publicId: localPublicId }, peerPrivateJwk);
    expect(res.status).toBe(200);
    expect(res.body?.name).toBe('Test Owner');
    expect(res.body?.fromDomain).toBe(TEST_LOCAL_DOMAIN);
    // Signed by our live key for the requesting peer's audience.
    const localKeys = (await getLocalKeys())!;
    const { signature, ...payload } = res.body!;
    void payload;
    await expect(
      jwtVerify(signature as string, await importJWK(localKeys.publicKey, 'EdDSA'), {
        issuer: TEST_LOCAL_DOMAIN,
        audience: PEER_DOMAIN
      })
    ).resolves.toBeDefined();
  });

  test('numeric userId is no longer a lookup key', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer('/federation/user-info', { userId: 1 }, peerPrivateJwk);
    expect(res.status).toBe(400);
  });

  test('does not answer for shadows of other instances', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    await seedShadow(peerInstanceId, 'remote-x');

    const res = await postSignedAsPeer(
      '/federation/user-info',
      { publicId: 'local-remote-x' },
      peerPrivateJwk
    );
    expect(res.status).toBe(404);
  });
});

/** Sign `{ domain, name, publicKey }` as a brand-new instance would. */
async function signedPeeringRequest(domain: string, name = 'New Peer') {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const publicJwk = JSON.stringify(await exportJWK(publicKey));
  const privateJwk = await exportJWK(privateKey);
  const body = { domain, name, publicKey: publicJwk };
  const signature = await _signChallengeAs(body, domain, TEST_LOCAL_DOMAIN, privateJwk);
  return { body: { ...body, signature }, publicJwk, privateJwk };
}

const postRequest = (body: Record<string, unknown>) =>
  fetch(`${testsBaseUrl}/federation/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

const infoResponse = (publicKey: string, version = '1.2.3') =>
  new Response(
    JSON.stringify({ domain: 'x', name: 'x', version, publicKey, federationEnabled: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );

describe('POST /federation/request', () => {
  test('a new peer whose /info serves the same key becomes an incoming pending row with its version', async () => {
    await initTest();
    mockDns();
    const { body, publicJwk } = await signedPeeringRequest('newpeer.example');
    const { calls } = spyOnFetch((call) =>
      call.url.endsWith('/federation/info')
        ? infoResponse(publicJwk, '0.4.0')
        : new Response('nope', { status: 404 })
    );

    const res = await postRequest(body);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.url === 'https://newpeer.example/federation/info')).toBe(true);

    const [row] = await db
      .select()
      .from(federationInstances)
      .where(eq(federationInstances.domain, 'newpeer.example'));
    expect(row).toMatchObject({
      status: 'pending',
      direction: 'incoming',
      publicKey: publicJwk,
      peerVersion: '0.4.0',
      name: 'New Peer'
    });
  });

  test('a bad signature is refused before anything is fetched', async () => {
    await initTest();
    mockDns();
    const { body } = await signedPeeringRequest('newpeer.example');
    const { calls } = spyOnFetch();

    const res = await postRequest({ ...body, name: 'Tampered' });
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect(await db.select().from(federationInstances)).toHaveLength(0);
  });

  test('a key the claimed domain does not serve is refused (spoofing)', async () => {
    await initTest();
    mockDns();
    const { body } = await signedPeeringRequest('victim.example');
    spyOnFetch(() => infoResponse('{"kty":"OKP","crv":"Ed25519","x":"someone-else"}'));

    const res = await postRequest(body);
    expect(res.status).toBe(401);
    expect(await db.select().from(federationInstances)).toHaveLength(0);
  });

  test('an unreachable claimed domain is refused', async () => {
    await initTest();
    mockDns();
    const { body } = await signedPeeringRequest('down.example');
    spyOnFetch(() => new Response('', { status: 503 }));

    const res = await postRequest(body);
    expect(res.status).toBe(400);
  });

  test('a malformed domain is refused', async () => {
    await initTest();
    const { body } = await signedPeeringRequest('evil.example/path');

    const res = await postRequest(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('Invalid domain');
  });

  test('the approval list is capped: a 51st pending request is 429', async () => {
    await initTest();
    mockDns();
    await db.insert(federationInstances).values(
      Array.from({ length: 50 }, (_, i) => ({
        domain: `junk-${i}.example`,
        name: `junk ${i}`,
        publicKey: '{"kty":"OKP","crv":"Ed25519","x":"junk"}',
        status: 'pending',
        direction: 'incoming',
        createdAt: Date.now()
      }))
    );
    const { body } = await signedPeeringRequest('one-more.example');
    const { calls } = spyOnFetch();

    const res = await postRequest(body);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(calls).toHaveLength(0);
  });

  test('a re-request from a known peer with a new key re-pins it and keeps the old key in grace', async () => {
    await initTest();
    mockDns();
    const { peerPrivateJwk } = await seedPeer();
    const [before] = await db.select().from(federationInstances);
    const { body, publicJwk } = await signedPeeringRequest(PEER_DOMAIN, 'Peer');
    spyOnFetch(() => infoResponse(publicJwk));

    const res = await postRequest(body);
    expect(res.status).toBe(200);

    const [after] = await db.select().from(federationInstances);
    expect(after!.publicKey).toBe(publicJwk);
    expect(after!.previousPublicKey).toBe(before!.publicKey);
    expect(after!.keyRotatedAt).not.toBeNull();
    expect(after!.status).toBe('active');

    // A relay the peer signed with the OLD key just before still verifies.
    const localPublicId = await getUserPublicId(1);
    const old = await postSignedAsPeer('/federation/user-info', { publicId: localPublicId }, peerPrivateJwk);
    expect(old.status).toBe(200);
  });
});

describe('POST /federation/accept', () => {
  const seedPendingOutgoing = async (peerPublicJwk: JWK) => {
    const [row] = await db
      .insert(federationInstances)
      .values({
        domain: PEER_DOMAIN,
        name: 'Peer',
        status: 'pending',
        direction: 'outgoing',
        publicKey: JSON.stringify(peerPublicJwk),
        createdAt: Date.now()
      })
      .returning();
    return row!;
  };

  test('activates a pairing WE requested and captures the peer version', async () => {
    await initTest();
    // seedPeer makes an active row; replace it with our outgoing-pending
    // one carrying the public half of the same peer key.
    const { peerPrivateJwk } = await seedPeer();
    await db.delete(federationInstances);
    const { d: _d, ...peerPublicJwk } = peerPrivateJwk;
    await seedPendingOutgoing(peerPublicJwk as JWK);
    mockDns();
    spyOnFetch((call) =>
      call.url.endsWith('/federation/info')
        ? infoResponse('irrelevant', '0.5.0')
        : new Response('nope', { status: 404 })
    );

    const res = await postSignedAsPeer('/federation/accept', { domain: PEER_DOMAIN }, peerPrivateJwk);
    expect(res.status).toBe(200);

    const [row] = await db.select().from(federationInstances);
    expect(row).toMatchObject({ status: 'active', direction: 'mutual', peerVersion: '0.5.0' });
  });

  test('accepts the pre-wave signature over { domain } alone', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    await db.delete(federationInstances);
    const { d: _d, ...pub } = peerPrivateJwk;
    await seedPendingOutgoing(pub as JWK);
    mockDns();
    spyOnFetch(() => new Response('', { status: 503 }));

    const bodyToSign = { domain: PEER_DOMAIN };
    const signature = await _signChallengeAs(bodyToSign, PEER_DOMAIN, TEST_LOCAL_DOMAIN, peerPrivateJwk);
    const res = await fetch(`${testsBaseUrl}/federation/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bodyToSign, signature })
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(federationInstances);
    expect(row!.status).toBe('active');
    // /info was unreachable: the version is simply not recorded.
    expect(row!.peerVersion).toBeNull();
  });

  test('refuses to activate an incoming request the local owner has not approved', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    await db
      .update(federationInstances)
      .set({ status: 'pending', direction: 'incoming' })
      .where(eq(federationInstances.domain, PEER_DOMAIN));

    const res = await postSignedAsPeer('/federation/accept', { domain: PEER_DOMAIN }, peerPrivateJwk);
    expect(res.status).toBe(403);
    const [row] = await db.select().from(federationInstances);
    expect(row!.status).toBe('pending');
  });

  test('the named domain must be the signer', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const res = await postSignedAsPeer('/federation/accept', { domain: 'someone-else.example' }, peerPrivateJwk);
    expect(res.status).toBe(400);
  });
});

describe('POST /federation/servers', () => {
  test('is a signed POST listing federatable servers with one grouped member count', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    await db.update(servers).set({ federatable: true }).where(eq(servers.id, 1));

    let res = await postSignedAsPeer('/federation/servers', {}, peerPrivateJwk);
    expect(res.status).toBe(200);
    expect(typeof res.body?.signature).toBe('string');
    expect(res.body?.fromDomain).toBe(TEST_LOCAL_DOMAIN);
    const list = res.body?.servers as Array<{ name: string; memberCount: number; hasPassword: boolean }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('Test Server');
    expect(list[0]!.memberCount).toBe(3);
    expect(list[0]!.hasPassword).toBe(false);

    // A server that is not federatable is not listed.
    await db.update(servers).set({ federatable: false }).where(eq(servers.id, 1));
    res = await postSignedAsPeer('/federation/servers', {}, peerPrivateJwk);
    expect(res.status).toBe(200);
    expect(res.body?.servers).toEqual([]);
  });

  test('the old unsigned GET is gone and an unsigned POST is refused', async () => {
    await initTest();
    await seedPeer();

    const get = await fetch(
      `${testsBaseUrl}/federation/servers?requesterDomain=${PEER_DOMAIN}`
    );
    expect(get.status).toBe(404);

    const post = await fetch(`${testsBaseUrl}/federation/servers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDomain: PEER_DOMAIN })
    });
    expect(post.status).toBe(400);
  });
});

describe('POST /federation/dm-group-create — third-instance members', () => {
  const signedUserInfoFrom = async (
    domain: string,
    body: Record<string, unknown>,
    privateJwk: JWK
  ): Promise<Response> => {
    const bodyToSign = { ...body, fromDomain: domain };
    const signature = await _signChallengeAs(bodyToSign, domain, TEST_LOCAL_DOMAIN, privateJwk);
    return new Response(JSON.stringify({ ...bodyToSign, signature }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const announce = (jwk: JWK, localPublicId: string, groupId: string) =>
    postSignedAsPeer(
      '/federation/dm-group-create',
      {
        federationGroupId: groupId,
        ownerPublicId: 'remote-owner-pid',
        members: [
          { publicId: 'remote-owner-pid', instanceDomain: PEER_DOMAIN, name: 'Owner' },
          { publicId: localPublicId, instanceDomain: TEST_LOCAL_DOMAIN, name: 'Local' },
          { publicId: 'pid-carol', instanceDomain: THIRD_DOMAIN, name: 'Impostor Name' }
        ]
      },
      jwk
    );

  test('a member homed elsewhere is minted only when that instance attests, under ITS name', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const { peerPrivateJwk: thirdJwk, peerInstanceId: thirdId } = await seedPeer(THIRD_DOMAIN);
    const localPublicId = await getUserPublicId(1);
    mockDns();
    const { calls } = spyOnFetch((call) =>
      call.url === `https://${THIRD_DOMAIN}/federation/user-info`
        ? signedUserInfoFrom(THIRD_DOMAIN, { name: 'Carol' }, thirdJwk)
        : new Response('nope', { status: 404 })
    );

    const res = await announce(peerPrivateJwk, localPublicId, 'fed-group-third');
    expect(res.status).toBe(200);

    const carol = await shadowFor(thirdId, 'pid-carol');
    expect(carol?.name).toBe('Carol');
    const members = await db
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, res.body?.dmChannelId as number));
    expect(members).toHaveLength(3);
    const attest = calls.find((c) => c.url.endsWith('/federation/user-info'));
    expect(attest?.body.publicId).toBe('pid-carol');
  });

  test('an unreachable or non-attesting home skips the member', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const { peerInstanceId: thirdId } = await seedPeer(THIRD_DOMAIN);
    const localPublicId = await getUserPublicId(1);
    mockDns();
    spyOnFetch(() => new Response('', { status: 503 }));

    const res = await announce(peerPrivateJwk, localPublicId, 'fed-group-third-down');
    expect(res.status).toBe(200);
    expect(await shadowFor(thirdId, 'pid-carol')).toBeUndefined();
    const members = await db
      .select({ userId: dmChannelMembers.userId })
      .from(dmChannelMembers)
      .where(eq(dmChannelMembers.dmChannelId, res.body?.dmChannelId as number));
    expect(members).toHaveLength(2);
  });

  test('a home that is not our peer is never asked', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    mockDns();
    const { calls } = spyOnFetch();

    const res = await announce(peerPrivateJwk, localPublicId, 'fed-group-third-unknown');
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(0);
  });
});
