/**
 * Peer-operations receivers and the per-peer budget:
 *   - POST /federation/report-user  (a peer forwards a report about OUR user)
 *   - POST /federation/unpeer       (the peer ended the pairing)
 *   - POST /federation/key-rotation (the peer replaced its signing key)
 *   - the per-verified-peer rate limit inside the shared prologue
 *
 * Setup is inline per test (no beforeEach — it deadlocks against the
 * global TRUNCATE). Outbound /federation/info fetches are stubbed with
 * `spyOnFetch`, which lets the post to the local server through.
 */

import { ServerEvents } from '@pulse/shared';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import { config } from '../../config';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  federationInstances,
  reports,
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
import { _signChallengeAs } from '../../utils/federation';
import { pubsub } from '../../utils/pubsub';
import {
  consumeRateLimit,
  federationPeerDmRelayRateLimit,
  federationPeerRateLimit
} from '../rate-limit-core';

config.federation.enabled = true;

afterEach(() => {
  mock.restore();
});

async function getUserPublicId(userId: number): Promise<string> {
  const [u] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return u!.publicId!;
}

async function seedShadow(instanceId: number, federatedPublicId: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      supabaseId: `federated-${federatedPublicId}`,
      name: federatedPublicId,
      publicId: `local-${federatedPublicId}`,
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId,
      createdAt: Date.now()
    })
    .returning({ id: users.id });
  return row!.id;
}

const peerRow = async () => {
  const [row] = await db
    .select()
    .from(federationInstances)
    .where(eq(federationInstances.domain, PEER_DOMAIN));
  return row!;
};

describe('POST /federation/report-user', () => {
  const report = (subjectPublicId: string, extra: Record<string, unknown> = {}) => ({
    subjectPublicId,
    reporterPublicId: 'remote-reporter-pid',
    serverPublicId: 'peer-server-pid',
    kind: 'message',
    reason: 'harassment',
    details: 'said something awful',
    messageExcerpt: 'the awful thing',
    ...extra
  });

  test('a signed report about a local user lands in the instance queue with its origin', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const subjectPublicId = await getUserPublicId(2);

    const res = await postSignedAsPeer('/federation/report-user', report(subjectPublicId), peerPrivateJwk);
    expect(res.status).toBe(200);
    expect(res.body?.success).toBe(true);

    const rows = await db.select().from(reports);
    expect(rows).toHaveLength(1);
    const [reporter] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.federatedInstanceId, peerInstanceId),
          eq(users.federatedPublicId, 'remote-reporter-pid')
        )
      );
    expect(rows[0]).toMatchObject({
      kind: 'message',
      reason: 'harassment',
      targetUserId: 2,
      reporterId: reporter!.id,
      audience: 'instance',
      status: 'open',
      source: `federated:${PEER_DOMAIN}`,
      contentSnapshot: 'the awful thing',
      snapshotAttested: true
    });
    expect(rows[0]!.details).toContain('said something awful');
    expect(rows[0]!.details).toContain(`Reported on ${PEER_DOMAIN}, server peer-server-pid`);
  });

  test('an unknown subject, or a shadow, is 200 ignored and stores nothing', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    await seedShadow(peerInstanceId, 'remote-someone');

    let res = await postSignedAsPeer('/federation/report-user', report('nobody-here'), peerPrivateJwk);
    expect(res.status).toBe(200);
    expect(res.body?.ignored).toBe('unknown_subject');

    res = await postSignedAsPeer('/federation/report-user', report('local-remote-someone'), peerPrivateJwk);
    expect(res.status).toBe(200);
    expect(res.body?.ignored).toBe('unknown_subject');

    expect(await db.select().from(reports)).toHaveLength(0);
  });

  test('kind and reason are validated, text fields bounded', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const subjectPublicId = await getUserPublicId(2);

    let res = await postSignedAsPeer(
      '/federation/report-user',
      report(subjectPublicId, { kind: 'drop table' }),
      peerPrivateJwk
    );
    expect(res.status).toBe(400);
    res = await postSignedAsPeer(
      '/federation/report-user',
      report(subjectPublicId, { reason: 'because' }),
      peerPrivateJwk
    );
    expect(res.status).toBe(400);

    res = await postSignedAsPeer(
      '/federation/report-user',
      report(subjectPublicId, {
        details: 'd'.repeat(10_000),
        messageExcerpt: 'e'.repeat(10_000),
        serverPublicId: null
      }),
      peerPrivateJwk
    );
    expect(res.status).toBe(200);
    const [row] = await db.select().from(reports);
    expect(row!.contentSnapshot).toHaveLength(1000);
    expect(row!.details!.length).toBeLessThan(1100);
    expect(row!.details).toContain(`Reported on ${PEER_DOMAIN}.`);
  });

  test('rejects unsigned reports', async () => {
    await initTest();
    await seedPeer();
    const res = await fetch(`${testsBaseUrl}/federation/report-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDomain: PEER_DOMAIN, ...report('x') })
    });
    expect(res.status).toBe(400);
    expect(await db.select().from(reports)).toHaveLength(0);
  });
});

describe('POST /federation/unpeer', () => {
  test('blocks the peer, sweeps its shadows and their DM channels, and publishes the change', async () => {
    await initTest();
    const { peerPrivateJwk, peerInstanceId } = await seedPeer();
    const shadowId = await seedShadow(peerInstanceId, 'remote-gone');
    const [channel] = await db
      .insert(dmChannels)
      .values({ isGroup: false, createdAt: Date.now() })
      .returning();
    await db.insert(dmChannelMembers).values([
      { dmChannelId: channel!.id, userId: 1, createdAt: Date.now() },
      { dmChannelId: channel!.id, userId: shadowId, createdAt: Date.now() }
    ]);

    const published: { topic: string; payload: unknown }[] = [];
    const originalPublish = pubsub.publish.bind(pubsub);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (pubsub as any).publish = (topic: string, payload: unknown) => {
      published.push({ topic, payload });
      return originalPublish(topic as never, payload as never);
    };
    try {
      const res = await postSignedAsPeer('/federation/unpeer', { reason: 'removed' }, peerPrivateJwk);
      expect(res.status).toBe(200);
      expect(res.body?.success).toBe(true);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (pubsub as any).publish = originalPublish;
    }

    expect((await peerRow()).status).toBe('blocked');
    expect(await db.select().from(users).where(eq(users.id, shadowId))).toHaveLength(0);
    expect(await db.select().from(dmChannels)).toHaveLength(0);
    expect(
      published.find((e) => e.topic === ServerEvents.FEDERATION_INSTANCE_UPDATE)?.payload
    ).toEqual({ domain: PEER_DOMAIN, status: 'blocked' });
  });

  test('is idempotent: a repeat against the blocked row is 200', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const first = await postSignedAsPeer('/federation/unpeer', { reason: 'blocked' }, peerPrivateJwk);
    expect(first.status).toBe(200);
    const second = await postSignedAsPeer('/federation/unpeer', { reason: 'blocked' }, peerPrivateJwk);
    expect(second.status).toBe(200);
    expect(second.body?.alreadyBlocked).toBe(true);
    expect((await peerRow()).status).toBe('blocked');
  });

  test('validates the reason and refuses a forged signature', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    const bad = await postSignedAsPeer('/federation/unpeer', { reason: 'bye' }, peerPrivateJwk);
    expect(bad.status).toBe(400);

    const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    const forged = await postSignedAsPeer('/federation/unpeer', { reason: 'removed' }, await exportJWK(privateKey));
    expect(forged.status).toBe(401);
    expect((await peerRow()).status).toBe('active');
  });
});

describe('POST /federation/key-rotation', () => {
  const freshKey = async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { extractable: true });
    return {
      publicJwkStr: JSON.stringify(await exportJWK(publicKey)),
      privateJwk: await exportJWK(privateKey)
    };
  };

  const infoWith = (publicKey: string) =>
    new Response(
      JSON.stringify({ domain: PEER_DOMAIN, name: 'Peer', version: '1.0.0', publicKey, federationEnabled: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  test('signed with the pinned key and confirmed by /info: the pin moves, the old key stays in grace', async () => {
    await initTest();
    const { peerPrivateJwk: oldJwk } = await seedPeer();
    const before = await peerRow();
    const next = await freshKey();
    mockDns();
    const { calls } = spyOnFetch((call) =>
      call.url.endsWith('/federation/info') ? infoWith(next.publicJwkStr) : new Response('', { status: 404 })
    );

    const res = await postSignedAsPeer(
      '/federation/key-rotation',
      { newPublicKey: next.publicJwkStr, rotatedAt: Date.now() },
      oldJwk
    );
    expect(res.status).toBe(200);
    expect(res.body?.applied).toBe(true);
    expect(calls.some((c) => c.url === `https://${PEER_DOMAIN}/federation/info`)).toBe(true);

    const after = await peerRow();
    expect(after.publicKey).toBe(next.publicJwkStr);
    expect(after.previousPublicKey).toBe(before.publicKey);
    expect(after.keyRotatedAt).not.toBeNull();

    // Both keys verify for the grace window; afterwards only the new one.
    const localPublicId = await getUserPublicId(1);
    const underNew = await postSignedAsPeer('/federation/user-info', { publicId: localPublicId }, next.privateJwk);
    expect(underNew.status).toBe(200);
    const underOld = await postSignedAsPeer('/federation/user-info', { publicId: localPublicId }, oldJwk);
    expect(underOld.status).toBe(200);

    await db
      .update(federationInstances)
      .set({ keyRotatedAt: Date.now() - 25 * 60 * 60 * 1000 })
      .where(eq(federationInstances.domain, PEER_DOMAIN));
    const expired = await postSignedAsPeer('/federation/user-info', { publicId: localPublicId }, oldJwk);
    expect(expired.status).toBe(401);
  });

  test('a repeat of an applied rotation is 200 applied:false', async () => {
    await initTest();
    const { peerPrivateJwk: oldJwk } = await seedPeer();
    const next = await freshKey();
    mockDns();
    const { calls } = spyOnFetch(() => infoWith(next.publicJwkStr));
    const body = { newPublicKey: next.publicJwkStr, rotatedAt: Date.now() };

    expect((await postSignedAsPeer('/federation/key-rotation', body, oldJwk)).body?.applied).toBe(true);
    const repeat = await postSignedAsPeer('/federation/key-rotation', body, oldJwk);
    expect(repeat.status).toBe(200);
    expect(repeat.body?.applied).toBe(false);
    // No second /info fetch for a no-op.
    expect(calls.filter((c) => c.url.endsWith('/federation/info'))).toHaveLength(1);
  });

  test('a key the peer does not advertise is refused and the pin is untouched', async () => {
    await initTest();
    const { peerPrivateJwk: oldJwk } = await seedPeer();
    const before = await peerRow();
    const next = await freshKey();
    const other = await freshKey();
    mockDns();
    spyOnFetch(() => infoWith(other.publicJwkStr));

    const res = await postSignedAsPeer(
      '/federation/key-rotation',
      { newPublicKey: next.publicJwkStr, rotatedAt: Date.now() },
      oldJwk
    );
    expect(res.status).toBe(403);
    const after = await peerRow();
    expect(after.publicKey).toBe(before.publicKey);
    expect(after.previousPublicKey).toBeNull();
  });

  test('an unreachable /info is a retryable 502; a push signed with the NEW key is a forgery', async () => {
    await initTest();
    const { peerPrivateJwk: oldJwk } = await seedPeer();
    const next = await freshKey();
    mockDns();
    spyOnFetch(() => new Response('', { status: 503 }));
    const body = { newPublicKey: next.publicJwkStr, rotatedAt: Date.now() };

    const down = await postSignedAsPeer('/federation/key-rotation', body, oldJwk);
    expect(down.status).toBe(502);

    const forged = await postSignedAsPeer('/federation/key-rotation', body, next.privateJwk);
    expect(forged.status).toBe(401);
    expect((await peerRow()).publicKey).not.toBe(next.publicJwkStr);
  });

  test('newPublicKey must be a bounded OKP JWK and rotatedAt an integer', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();

    let res = await postSignedAsPeer(
      '/federation/key-rotation',
      { newPublicKey: '{"kty":"RSA","n":"x"}', rotatedAt: Date.now() },
      peerPrivateJwk
    );
    expect(res.status).toBe(400);
    res = await postSignedAsPeer(
      '/federation/key-rotation',
      { newPublicKey: '{"kty":"OKP","crv":"Ed25519","x":"y"}', rotatedAt: 'now' },
      peerPrivateJwk
    );
    expect(res.status).toBe(400);
  });
});

describe('per-peer rate limit', () => {
  const signedPost = async (path: string, payload: Record<string, unknown>, jwk: JWK) => {
    const bodyToSign = { ...payload, fromDomain: PEER_DOMAIN };
    const signature = await _signChallengeAs(bodyToSign, PEER_DOMAIN, TEST_LOCAL_DOMAIN, jwk);
    return fetch(`${testsBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...bodyToSign, signature })
    });
  };

  test('a verified peer past its general budget gets 429 with Retry-After; another peer is unaffected', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const { peerPrivateJwk: otherJwk } = await seedPeer('other.example');
    const localPublicId = await getUserPublicId(1);
    for (let i = 0; i < federationPeerRateLimit.maxRequests; i++) {
      consumeRateLimit(`peer:general:${PEER_DOMAIN}`, federationPeerRateLimit);
    }

    const limited = await signedPost('/federation/user-info', { publicId: localPublicId }, peerPrivateJwk);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);

    const other = await postSignedAsPeer(
      '/federation/user-info',
      { publicId: localPublicId },
      otherJwk,
      'other.example'
    );
    expect(other.status).toBe(200);
  });

  test('dm-relay has its own, tighter budget; the general one is untouched by it', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);
    for (let i = 0; i < federationPeerDmRelayRateLimit.maxRequests; i++) {
      consumeRateLimit(`peer:dmRelay:${PEER_DOMAIN}`, federationPeerDmRelayRateLimit);
    }

    const relay = await signedPost(
      '/federation/dm-relay',
      { fromUsername: 'R', fromPublicId: 'remote-pid', toPublicId: localPublicId, content: 'x' },
      peerPrivateJwk
    );
    expect(relay.status).toBe(429);

    const info = await postSignedAsPeer('/federation/user-info', { publicId: localPublicId }, peerPrivateJwk);
    expect(info.status).toBe(200);
  });

  test('an unsigned flood cannot drain a peer budget (the limit applies after verification)', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const localPublicId = await getUserPublicId(1);

    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${testsBaseUrl}/federation/user-info`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromDomain: PEER_DOMAIN, publicId: localPublicId, signature: 'junk' })
      });
      expect(res.status).toBe(401);
    }
    const bucket = consumeRateLimit(`peer:general:${PEER_DOMAIN}`, federationPeerRateLimit);
    expect(bucket.allowed).toBe(true);
    // Only this probe consumed from the bucket — the forgeries did not.
    for (let i = 1; i < federationPeerRateLimit.maxRequests - 1; i++) {
      expect(consumeRateLimit(`peer:general:${PEER_DOMAIN}`, federationPeerRateLimit).allowed).toBe(true);
    }
    const ok = await postSignedAsPeer('/federation/user-info', { publicId: localPublicId }, peerPrivateJwk);
    expect(ok.status).toBe(200);
  });
});
