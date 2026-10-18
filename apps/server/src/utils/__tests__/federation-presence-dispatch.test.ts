/**
 * Presence pushes to peers: first live socket → current status,
 * last socket closed → `offline` after a debounce that a reconnect
 * cancels. Same fetch-spy + DNS-mock approach as the E3 dispatcher
 * tests; the debounce is shortened through the test hook.
 */

import { afterEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { db } from '../../db';
import {
  dmChannelMembers,
  dmChannels,
  federationOutbox,
  users
} from '../../db/schema';
import {
  mockDns,
  seedPeerInstance,
  spyOnFetch
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { generateFederationKeys } from '../federation';
import {
  _setPresenceOfflineDebounceForTests,
  relayPresenceConnected,
  schedulePresenceOffline
} from '../federation-user-info-dispatch';

config.federation.enabled = true;

const PEER_DOMAIN = 'peer.presence.example.com';
const DEBOUNCE_MS = 40;

afterEach(() => {
  _setPresenceOfflineDebounceForTests(undefined);
  mock.restore();
});

/** Peer + shadow sharing a 1:1 with local user 1, so the peer is in scope. */
async function seedPeerWithDm(): Promise<void> {
  const instanceId = await seedPeerInstance(PEER_DOMAIN);
  const [shadow] = await db
    .insert(users)
    .values({
      supabaseId: 'presence-shadow',
      name: 'Shadow',
      publicId: 'presence-shadow-pid',
      isFederated: true,
      federatedInstanceId: instanceId,
      federatedPublicId: 'remote-presence-pid',
      createdAt: Date.now()
    })
    .returning();
  const [channel] = await db
    .insert(dmChannels)
    .values({ isGroup: false, e2ee: false, createdAt: Date.now() })
    .returning();
  await db.insert(dmChannelMembers).values([
    { dmChannelId: channel!.id, userId: 1, createdAt: Date.now() },
    { dmChannelId: channel!.id, userId: shadow!.id, createdAt: Date.now() }
  ]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const statusPushes = (calls: { url: string; body: Record<string, unknown> }[]) =>
  calls
    .filter((c) => c.url.includes('/federation/user-info-update'))
    .map((c) => c.body.status);

describe('presence dispatch', () => {
  test('connect pushes the current status once; nothing is queued', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerWithDm();
    const { calls } = spyOnFetch();

    relayPresenceConnected(1, 'online');
    await sleep(60);

    expect(statusPushes(calls)).toEqual(['online']);
    expect(await db.select().from(federationOutbox)).toHaveLength(0);
  });

  test('last socket closed pushes offline after the debounce', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerWithDm();
    _setPresenceOfflineDebounceForTests(DEBOUNCE_MS);
    const { calls } = spyOnFetch();

    schedulePresenceOffline(1, () => false);
    await sleep(10);
    expect(statusPushes(calls)).toEqual([]);

    await sleep(DEBOUNCE_MS + 60);
    expect(statusPushes(calls)).toEqual(['offline']);
  });

  test('a socket that reappears inside the debounce suppresses the offline push', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerWithDm();
    _setPresenceOfflineDebounceForTests(DEBOUNCE_MS);
    const { calls } = spyOnFetch();

    schedulePresenceOffline(1, () => true);
    await sleep(DEBOUNCE_MS + 60);

    expect(statusPushes(calls)).toEqual([]);
  });

  test('reconnect cancels the pending offline and pushes the live status', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerWithDm();
    _setPresenceOfflineDebounceForTests(DEBOUNCE_MS);
    const { calls } = spyOnFetch();

    schedulePresenceOffline(1, () => false);
    relayPresenceConnected(1, 'idle');
    await sleep(DEBOUNCE_MS + 60);

    expect(statusPushes(calls)).toEqual(['idle']);
  });

  test('a shadow user never announces presence', async () => {
    await initTest(1);
    await generateFederationKeys();
    mockDns();
    await seedPeerWithDm();
    _setPresenceOfflineDebounceForTests(DEBOUNCE_MS);
    const { calls } = spyOnFetch();
    const [shadow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.supabaseId, 'presence-shadow'));

    relayPresenceConnected(shadow!.id, 'online');
    schedulePresenceOffline(shadow!.id, () => false);
    await sleep(DEBOUNCE_MS + 60);

    expect(statusPushes(calls)).toEqual([]);
  });
});
