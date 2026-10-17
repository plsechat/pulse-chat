/**
 * Phase E / E3 — server-side dispatcher tests for user-info push.
 *
 * Same fetch-spy approach as the E2 channel-state dispatcher tests.
 * Real-format domains + DNS mocks so `validateFederationUrl`
 * (called inside `federationFetch`) accepts the requests.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { config } from '../../config';
import { db } from '../../db';
import { dmChannelMembers, dmChannels, federationInstances, friendships, users } from '../../db/schema';
import {
  expectDispatcherLogsDbError,
  mockDns,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../federation';
import { relayUserInfoUpdate } from '../federation-user-info-dispatch';

config.federation.enabled = true;

const PEER_DOMAIN_A = 'peera.userinfo.example.com';
const PEER_DOMAIN_B = 'peerb.userinfo.example.com';

afterEach(() => {
  mock.restore();
});

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

/**
 * The relay is fire-and-forget; wait for the expected number of
 * user-info-update calls (bounded) instead of a fixed pause that a
 * loaded runner overruns.
 */
const updatesAmong = (calls: { url: string }[]) =>
  calls.filter((c) => c.url.includes('/federation/user-info-update'));

const waitForUpdates = async (calls: { url: string }[], n: number) => {
  // Expecting none: give a wrong relay a moment to show up before asserting.
  if (n === 0) await new Promise((r) => setTimeout(r, 150));
  for (let i = 0; i < 200 && updatesAmong(calls).length < n; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return updatesAmong(calls);
};

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
    const updates = await waitForUpdates(calls, 1);
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
    const updates = await waitForUpdates(calls, 2);
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
    const updates = await waitForUpdates(calls, 0);
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
    const updates = await waitForUpdates(calls, 0);
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
    const updates = await waitForUpdates(calls, 0);
    expect(updates).toHaveLength(0);
  });

  test('profile-field changes (name/bio/bannerColor) forwarded inline', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedFederatedPeerWithDmFriend(
      PEER_DOMAIN_A,
      'shadow-e3-profile',
      'remote-profile'
    );

    const { calls } = spyOnFetch();

    await relayUserInfoUpdate(1, {
      name: 'NewName',
      bio: 'New bio',
      bannerColor: '#ff5500'
    });
    const updates = await waitForUpdates(calls, 1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body.name).toBe('NewName');
    expect(updates[0]!.body.bio).toBe('New bio');
    expect(updates[0]!.body.bannerColor).toBe('#ff5500');
  });

  test('triggerProfileSync flag is forwarded for avatar/banner changes', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedFederatedPeerWithDmFriend(
      PEER_DOMAIN_A,
      'shadow-e3-trigger',
      'remote-trigger'
    );

    const { calls } = spyOnFetch();

    // Avatar/banner changes don't carry data inline — they signal
    // the receiver to re-pull the full profile.
    await relayUserInfoUpdate(1, { triggerProfileSync: true });
    const updates = await waitForUpdates(calls, 1);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.body.triggerProfileSync).toBe(true);
  });
});

describe('relayUserInfoUpdate resilience', () => {
  test('a DB failure before any relay is logged, never thrown', async () => {
    await initTest(1);

    await expectDispatcherLogsDbError(
      () => relayUserInfoUpdate(1, { status: 'idle' }),
      'relayUserInfoUpdate'
    );
  });
});
