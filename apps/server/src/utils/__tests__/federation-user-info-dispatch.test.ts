/**
 * Phase E / E3 — server-side dispatcher tests for user-info push.
 *
 * Same fetch-spy approach as the E2 channel-state dispatcher tests.
 * Real-format domains + DNS mocks so `validateFederationUrl`
 * (called inside `federationFetch`) accepts the requests.
 */

import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import dns from 'dns/promises';
import { config } from '../../config';
import { db } from '../../db';
import { dmChannelMembers, dmChannels, federationInstances, friendships, users } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../federation';
import { relayUserInfoUpdate } from '../federation-user-info-dispatch';

config.federation.enabled = true;

const PEER_DOMAIN_A = 'peera.userinfo.example.com';
const PEER_DOMAIN_B = 'peerb.userinfo.example.com';

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
    return new Response(JSON.stringify({ applied: true }), {
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

async function seedFederatedPeerWithDmFriend(
  domain: string,
  shadowSupabaseId: string,
  remotePublicId: string
): Promise<{ shadowId: number; instanceId: number; channelId: number }> {
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

  const [shadow] = await db
    .insert(users)
    .values({
      supabaseId: shadowSupabaseId,
      name: 'Shadow',
      publicId: `shadow-pid-${shadowSupabaseId}`,
      isFederated: true,
      federatedInstanceId: instance!.id,
      federatedPublicId: remotePublicId,
      createdAt: Date.now()
    })
    .returning();

  await db.insert(friendships).values({
    userId: 1,
    friendId: shadow!.id,
    createdAt: Date.now()
  });

  // The dispatcher's peer enumeration uses enumerateRotationPeers,
  // which scopes to instances of users sharing a DM channel with
  // the local user. So we need an actual DM channel between user 1
  // and the shadow.
  const [channel] = await db
    .insert(dmChannels)
    .values({ isGroup: false, e2ee: false, createdAt: Date.now() })
    .returning();

  await db.insert(dmChannelMembers).values([
    { dmChannelId: channel!.id, userId: 1, createdAt: Date.now() },
    { dmChannelId: channel!.id, userId: shadow!.id, createdAt: Date.now() }
  ]);

  return { shadowId: shadow!.id, instanceId: instance!.id, channelId: channel!.id };
}

describe('relayUserInfoUpdate (E3)', () => {
  test('local user with one federated DM peer dispatches a single relay', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedFederatedPeerWithDmFriend(
      PEER_DOMAIN_A,
      'shadow-e3-single',
      'remote-pid-single'
    );

    const { calls } = spyOnFetch();

    await relayUserInfoUpdate(1, { status: 'idle' });
    await new Promise((r) => setTimeout(r, 20));

    const updates = calls.filter((c) =>
      c.url.includes('/federation/user-info-update')
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.url).toContain(PEER_DOMAIN_A);
    expect(updates[0]!.body.status).toBe('idle');
    expect(typeof updates[0]!.body.subjectPublicId).toBe('string');
  });

  test('multiple federated DM peers across instances each get one relay (deduped per instance)', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedFederatedPeerWithDmFriend(PEER_DOMAIN_A, 'shadow-e3-A', 'remote-A');
    await seedFederatedPeerWithDmFriend(PEER_DOMAIN_B, 'shadow-e3-B', 'remote-B');

    const { calls } = spyOnFetch();

    await relayUserInfoUpdate(1, { status: 'dnd' });
    await new Promise((r) => setTimeout(r, 20));

    const updates = calls.filter((c) =>
      c.url.includes('/federation/user-info-update')
    );
    expect(updates).toHaveLength(2);
    const domains = new Set(updates.map((c) => new URL(c.url).host));
    expect(domains).toEqual(new Set([PEER_DOMAIN_A, PEER_DOMAIN_B]));
  });

  test('local user with no federated DM peers does not dispatch', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();

    const { calls } = spyOnFetch();

    await relayUserInfoUpdate(1, { status: 'idle' });
    await new Promise((r) => setTimeout(r, 20));

    const updates = calls.filter((c) =>
      c.url.includes('/federation/user-info-update')
    );
    expect(updates).toHaveLength(0);
  });

  test('federated (shadow) user as the subject is silently skipped', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    const { shadowId } = await seedFederatedPeerWithDmFriend(
      PEER_DOMAIN_A,
      'shadow-e3-trying-to-relay-self',
      'remote-pid-self'
    );

    const { calls } = spyOnFetch();

    // Calling with a federated user id should no-op — only local
    // users push their own changes.
    await relayUserInfoUpdate(shadowId, { status: 'idle' });
    await new Promise((r) => setTimeout(r, 20));

    const updates = calls.filter((c) =>
      c.url.includes('/federation/user-info-update')
    );
    expect(updates).toHaveLength(0);
  });

  test('empty changes object dispatches nothing', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedFederatedPeerWithDmFriend(
      PEER_DOMAIN_A,
      'shadow-e3-empty',
      'remote-empty'
    );

    const { calls } = spyOnFetch();

    await relayUserInfoUpdate(1, {});
    await new Promise((r) => setTimeout(r, 20));

    const updates = calls.filter((c) =>
      c.url.includes('/federation/user-info-update')
    );
    expect(updates).toHaveLength(0);
  });
});
