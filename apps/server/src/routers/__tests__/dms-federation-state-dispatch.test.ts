/**
 * Phase E / E2 — server-side dispatcher integration tests for DM
 * channel state propagation.
 *
 * `relayFederatedDmChannelStateUpdate` calls `relayToInstance` per
 * peer (fire-and-forget). To verify the dispatcher's intent we spy
 * on `globalThis.fetch` and assert the URL + body shape that gets
 * relayed. The actual signed-body / signature path is exercised by
 * `federation-handlers.test.ts` from the receiving end.
 *
 * Inline setup (no beforeEach) per the cross-file deadlock pattern.
 */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import dns from 'dns/promises';
import { config } from '../../config';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  federationInstances,
  friendships,
  users
} from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../../utils/federation';
import { relayFederatedDmChannelStateUpdate } from '../../utils/federation-dm-state-dispatch';

config.federation.enabled = true;

// Real-format domains so `validateFederationUrl` (called inside
// `federationFetch`) accepts them. DNS is mocked below to point them
// at a public IP so the SSRF validator doesn't reject the resolution
// either. Mirrors the pattern in federation-sync.test.ts.
const PEER_DOMAIN_A = 'peera.example.com';
const PEER_DOMAIN_B = 'peerb.example.com';

type FetchCall = {
  url: string;
  method: string;
  body: Record<string, unknown>;
};

const originalFetch = globalThis.fetch;

function spyOnFetch(): { calls: FetchCall[]; restore: () => void } {
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
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  });
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    }
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function mockDns() {
  spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34']);
  spyOn(dns, 'resolve6').mockRejectedValue(new Error('NODATA'));
}

async function seedFederatedPeer(domain: string): Promise<{ instanceId: number }> {
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
  return { instanceId: instance!.id };
}

async function seedShadowFriend(
  instanceId: number,
  remotePublicId: string,
  name: string
): Promise<number> {
  const [shadow] = await db
    .insert(users)
    .values({
      supabaseId: `shadow-${remotePublicId}`,
      name,
      publicId: `shadow-pid-${remotePublicId}`,
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId: remotePublicId,
      createdAt: Date.now()
    })
    .returning();
  await db.insert(friendships).values({
    userId: 1,
    friendId: shadow!.id,
    createdAt: Date.now()
  });
  return shadow!.id;
}

async function seedLocalFriend(name: string): Promise<number> {
  const [local] = await db
    .insert(users)
    .values({
      supabaseId: `local-${name}`,
      name,
      publicId: `local-pid-${name}`,
      isFederated: false,
      createdAt: Date.now()
    })
    .returning();
  await db.insert(friendships).values({
    userId: 1,
    friendId: local!.id,
    createdAt: Date.now()
  });
  return local!.id;
}

async function createDmChannel(
  isGroup: boolean,
  memberIds: number[],
  federationGroupId?: string
): Promise<number> {
  const [ch] = await db
    .insert(dmChannels)
    .values({
      isGroup,
      e2ee: false,
      ...(federationGroupId ? { federationGroupId } : {}),
      createdAt: Date.now()
    })
    .returning();
  await db.insert(dmChannelMembers).values(
    memberIds.map((userId) => ({
      dmChannelId: ch!.id,
      userId,
      createdAt: Date.now()
    }))
  );
  return ch!.id;
}

describe('relayFederatedDmChannelStateUpdate (E2)', () => {
  test('1:1 federated DM dispatches one relay to the peer with toPublicId/fromPublicId', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    const peer = await seedFederatedPeer(PEER_DOMAIN_A);
    const shadow = await seedShadowFriend(peer.instanceId, 'peerA-user-pid', 'PeerA');
    const channelId = await createDmChannel(false, [1, shadow]);

    const { calls } = spyOnFetch();

    await relayFederatedDmChannelStateUpdate(channelId, 1, { e2ee: true });
    // Allow the fire-and-forget call to enqueue.
    await new Promise((r) => setTimeout(r, 20));

    const stateCalls = calls.filter((c) =>
      c.url.includes('/federation/dm-channel-state-update')
    );
    expect(stateCalls).toHaveLength(1);
    expect(stateCalls[0]!.url).toContain(PEER_DOMAIN_A);
    expect(stateCalls[0]!.body.toPublicId).toBe('peerA-user-pid');
    expect(stateCalls[0]!.body.e2ee).toBe(true);
    expect(typeof stateCalls[0]!.body.fromPublicId).toBe('string');
  });

  test('group DM dispatches once per unique peer instance', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    const peerA = await seedFederatedPeer(PEER_DOMAIN_A);
    const peerB = await seedFederatedPeer(PEER_DOMAIN_B);
    // Two shadow friends from peer A and one from peer B —
    // dispatch should fire ONCE per peer (deduped), not per member.
    const a1 = await seedShadowFriend(peerA.instanceId, 'a1-pid', 'A1');
    const a2 = await seedShadowFriend(peerA.instanceId, 'a2-pid', 'A2');
    const b1 = await seedShadowFriend(peerB.instanceId, 'b1-pid', 'B1');
    const channelId = await createDmChannel(
      true,
      [1, a1, a2, b1],
      'fed-group-state-dispatch'
    );

    const { calls } = spyOnFetch();

    await relayFederatedDmChannelStateUpdate(channelId, 1, { e2ee: true });
    await new Promise((r) => setTimeout(r, 20));

    const stateCalls = calls.filter((c) =>
      c.url.includes('/federation/dm-channel-state-update')
    );
    expect(stateCalls).toHaveLength(2);
    const domains = stateCalls.map((c) => new URL(c.url).host);
    expect(new Set(domains)).toEqual(new Set([PEER_DOMAIN_A, PEER_DOMAIN_B]));
    for (const c of stateCalls) {
      expect(c.body.federationGroupId).toBe('fed-group-state-dispatch');
      expect(c.body.e2ee).toBe(true);
    }
  });

  test('all-local DM does not dispatch', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    const localFriend = await seedLocalFriend('localOnly');
    const channelId = await createDmChannel(false, [1, localFriend]);

    const { calls } = spyOnFetch();

    await relayFederatedDmChannelStateUpdate(channelId, 1, { e2ee: true });
    await new Promise((r) => setTimeout(r, 20));

    const stateCalls = calls.filter((c) =>
      c.url.includes('/federation/dm-channel-state-update')
    );
    expect(stateCalls).toHaveLength(0);
  });

  test('group missing federationGroupId is skipped (logged, no relay)', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    const peer = await seedFederatedPeer(PEER_DOMAIN_A);
    const shadow = await seedShadowFriend(peer.instanceId, 'no-fgid-pid', 'NoFGID');
    // Group with a federated member but no federationGroupId — this
    // is an inconsistent state we should warn-skip on, not relay an
    // unaddressable update.
    const channelId = await createDmChannel(true, [1, shadow]);

    const { calls } = spyOnFetch();

    await relayFederatedDmChannelStateUpdate(channelId, 1, { e2ee: true });
    await new Promise((r) => setTimeout(r, 20));

    const stateCalls = calls.filter((c) =>
      c.url.includes('/federation/dm-channel-state-update')
    );
    expect(stateCalls).toHaveLength(0);
  });

  test('empty changes set does not dispatch', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    const peer = await seedFederatedPeer(PEER_DOMAIN_A);
    const shadow = await seedShadowFriend(peer.instanceId, 'empty-changes', 'EmptyChanges');
    const channelId = await createDmChannel(false, [1, shadow]);

    const { calls } = spyOnFetch();

    await relayFederatedDmChannelStateUpdate(channelId, 1, {});
    await new Promise((r) => setTimeout(r, 20));

    const stateCalls = calls.filter((c) =>
      c.url.includes('/federation/dm-channel-state-update')
    );
    expect(stateCalls).toHaveLength(0);
  });
});
