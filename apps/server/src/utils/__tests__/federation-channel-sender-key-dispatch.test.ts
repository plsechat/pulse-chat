/**
 * Phase E / E1d — dispatcher tests for federated channel SKDM
 * notifications. Same fetch-spy pattern as the E2 / E3 dispatcher
 * tests; real-format peer domains + DNS mocks so
 * `validateFederationUrl` accepts the request URL.
 */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import dns from 'dns/promises';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import { channels, federationInstances, users } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../federation';
import { relayFederatedChannelSenderKeyNotifications } from '../federation-channel-sender-key-dispatch';

config.federation.enabled = true;

const PEER_DOMAIN_A = 'peera.skdmnotify.example.com';
const PEER_DOMAIN_B = 'peerb.skdmnotify.example.com';

type FetchCall = {
  url: string;
  method: string;
  body: Record<string, unknown>;
};

const originalFetch = globalThis.fetch;

function spyOnFetch(): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fakeFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    let body: Record<string, unknown> = {};
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = {};
      }
    }
    calls.push({ url: u, method: init?.method ?? 'GET', body });
    return new Response(JSON.stringify({ notified: 0 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function mockDns() {
  spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
  spyOn(dns, 'resolve6').mockRejectedValue(new Error('NODATA'));
}

async function seedPeerInstance(domain: string): Promise<number> {
  const [instance] = await db
    .insert(federationInstances)
    .values({
      domain,
      name: domain,
      status: 'active',
      direction: 'outgoing',
      publicKey: '{"kty":"OKP","crv":"Ed25519","x":"placeholder"}',
      createdAt: Date.now()
    })
    .returning();
  return instance!.id;
}

async function ensureChannelHasPublicId(channelId: number): Promise<string> {
  const publicId = `channel-pid-${channelId}-${Date.now()}`;
  await db.update(channels).set({ publicId }).where(eq(channels.id, channelId));
  return publicId;
}

async function ensureUserHasPublicId(userId: number): Promise<string> {
  const [u] = await db
    .select({ publicId: users.publicId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.publicId) return u.publicId;
  const publicId = `user-pid-${userId}-${Date.now()}`;
  await db.update(users).set({ publicId }).where(eq(users.id, userId));
  return publicId;
}

describe('relayFederatedChannelSenderKeyNotifications (E1d)', () => {
  test('one peer instance: dispatches a single signed notification', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_DOMAIN_A);
    const channelPid = await ensureChannelHasPublicId(1);
    const senderPid = await ensureUserHasPublicId(1);

    const { calls } = spyOnFetch();

    await relayFederatedChannelSenderKeyNotifications({
      channelId: 1,
      fromUserId: 1,
      senderKeyId: 5,
      targets: [
        { toPublicId: 'remote-recipient-1', toInstanceDomain: PEER_DOMAIN_A }
      ]
    });
    await new Promise((r) => setTimeout(r, 20));

    const notifies = calls.filter((c) =>
      c.url.includes('/federation/channel-sender-key-notify')
    );
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.url).toContain(PEER_DOMAIN_A);
    expect(notifies[0]!.body.hostChannelPublicId).toBe(channelPid);
    expect(notifies[0]!.body.fromPublicId).toBe(senderPid);
    expect(notifies[0]!.body.senderKeyId).toBe(5);
    expect(notifies[0]!.body.recipientPublicIds).toEqual(['remote-recipient-1']);
  });

  test('multiple recipients on the same peer fold into one POST with a deduped list', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_DOMAIN_A);
    await ensureChannelHasPublicId(1);
    await ensureUserHasPublicId(1);

    const { calls } = spyOnFetch();

    await relayFederatedChannelSenderKeyNotifications({
      channelId: 1,
      fromUserId: 1,
      senderKeyId: 1,
      targets: [
        { toPublicId: 'r1', toInstanceDomain: PEER_DOMAIN_A },
        { toPublicId: 'r2', toInstanceDomain: PEER_DOMAIN_A },
        { toPublicId: 'r3', toInstanceDomain: PEER_DOMAIN_A }
      ]
    });
    await new Promise((r) => setTimeout(r, 20));

    const notifies = calls.filter((c) =>
      c.url.includes('/federation/channel-sender-key-notify')
    );
    expect(notifies).toHaveLength(1);
    expect(notifies[0]!.body.recipientPublicIds).toEqual(['r1', 'r2', 'r3']);
  });

  test('targets across two peers each get their own POST', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_DOMAIN_A);
    await seedPeerInstance(PEER_DOMAIN_B);
    await ensureChannelHasPublicId(1);
    await ensureUserHasPublicId(1);

    const { calls } = spyOnFetch();

    await relayFederatedChannelSenderKeyNotifications({
      channelId: 1,
      fromUserId: 1,
      senderKeyId: 1,
      targets: [
        { toPublicId: 'r1a', toInstanceDomain: PEER_DOMAIN_A },
        { toPublicId: 'r2a', toInstanceDomain: PEER_DOMAIN_A },
        { toPublicId: 'r1b', toInstanceDomain: PEER_DOMAIN_B }
      ]
    });
    await new Promise((r) => setTimeout(r, 20));

    const notifies = calls.filter((c) =>
      c.url.includes('/federation/channel-sender-key-notify')
    );
    expect(notifies).toHaveLength(2);

    const byDomain = new Map(notifies.map((c) => [new URL(c.url).host, c]));
    expect(byDomain.get(PEER_DOMAIN_A)!.body.recipientPublicIds).toEqual(['r1a', 'r2a']);
    expect(byDomain.get(PEER_DOMAIN_B)!.body.recipientPublicIds).toEqual(['r1b']);
  });

  test('targets pointing at our own domain are dropped', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_DOMAIN_A);
    await ensureChannelHasPublicId(1);
    await ensureUserHasPublicId(1);

    const { calls } = spyOnFetch();

    await relayFederatedChannelSenderKeyNotifications({
      channelId: 1,
      fromUserId: 1,
      senderKeyId: 1,
      targets: [
        { toPublicId: 'self', toInstanceDomain: config.federation.domain }
      ]
    });
    await new Promise((r) => setTimeout(r, 20));

    const notifies = calls.filter((c) =>
      c.url.includes('/federation/channel-sender-key-notify')
    );
    expect(notifies).toHaveLength(0);
  });

  test('inactive peer instance is skipped', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    // Insert peer with status = 'paused' rather than 'active'.
    await db
      .insert(federationInstances)
      .values({
        domain: PEER_DOMAIN_A,
        name: PEER_DOMAIN_A,
        status: 'paused',
        direction: 'outgoing',
        publicKey: '{"kty":"OKP","crv":"Ed25519","x":"placeholder"}',
        createdAt: Date.now()
      });
    await ensureChannelHasPublicId(1);
    await ensureUserHasPublicId(1);

    const { calls } = spyOnFetch();

    await relayFederatedChannelSenderKeyNotifications({
      channelId: 1,
      fromUserId: 1,
      senderKeyId: 1,
      targets: [
        { toPublicId: 'r1', toInstanceDomain: PEER_DOMAIN_A }
      ]
    });
    await new Promise((r) => setTimeout(r, 20));

    const notifies = calls.filter((c) =>
      c.url.includes('/federation/channel-sender-key-notify')
    );
    expect(notifies).toHaveLength(0);
  });

  test('channel without publicId is skipped (logged) — no relay', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerInstance(PEER_DOMAIN_A);
    // Explicitly null out channel publicId — simulating a pre-E1a row
    // that hasn't been backfilled.
    await db.update(channels).set({ publicId: null }).where(eq(channels.id, 1));
    await ensureUserHasPublicId(1);

    const { calls } = spyOnFetch();

    await relayFederatedChannelSenderKeyNotifications({
      channelId: 1,
      fromUserId: 1,
      senderKeyId: 1,
      targets: [
        { toPublicId: 'r1', toInstanceDomain: PEER_DOMAIN_A }
      ]
    });
    await new Promise((r) => setTimeout(r, 20));

    const notifies = calls.filter((c) =>
      c.url.includes('/federation/channel-sender-key-notify')
    );
    expect(notifies).toHaveLength(0);
  });

  test('empty target list dispatches nothing', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();

    const { calls } = spyOnFetch();

    await relayFederatedChannelSenderKeyNotifications({
      channelId: 1,
      fromUserId: 1,
      senderKeyId: 1,
      targets: []
    });
    await new Promise((r) => setTimeout(r, 20));

    const notifies = calls.filter((c) =>
      c.url.includes('/federation/channel-sender-key-notify')
    );
    expect(notifies).toHaveLength(0);
  });
});
