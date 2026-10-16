/**
 * Instance-explicit channel sender-key distribution.
 *
 *  - A member who joins after our first message gets our SKDM on the
 *    next ensure pass: the roster cache is dropped on join and expires
 *    on its own, instead of living for the whole session.
 *  - Home and a federated host are separate instances end-to-end:
 *    same numeric channel id, separate in-flight passes, separate
 *    stores, chains keyed by each instance's own user id, rosters from
 *    each instance's client, resolution through home.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/instance-explicit.test.ts
 */

import './instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createPeer,
  fakeTrpc,
  federatedEntry,
  installModuleMocks,
  installClients,
  installHomeIdentity,
  resetInstanceState,
  setInstanceState,
  type FakeTrpc,
  type Peer
} from './instance-harness';
import type { E2eeInstance } from '..';
import type { SenderKeyDistribution } from '../sender-key-chain';

// Re-assert the harness mocks (another file may have replaced them since
// the harness first loaded), then import the lib — a static import would
// bind index.ts to whatever modules were registered first.
installModuleMocks();
const {
  distributeSenderKeysToOnlineMember,
  ensureChannelSenderKey,
  getActiveE2eeInstance,
  getHomeE2eeInstance,
  invalidateChannelMembers
} = await import('..');
const { getStoreForInstance, signalStore } = await import('../store');

const HOME_DOMAIN = 'home.test';
const HOST_DOMAIN = 'host.test';
const CHANNEL_ID = 3;
const ME_HOME = 10;
const ME_HOST = 5;

type Descriptor = {
  id: number;
  name: string;
  publicId: string;
  instanceDomain: string;
};

type Batch = {
  channelId: number;
  senderKeyId: number;
  distributions: { toPublicId: string; distributionMessage: string }[];
};

/**
 * A fake instance server: a roster the test mutates, peers addressed
 * by the HOME ids the resolver answers with, and the e2ee routes the
 * distribute path touches.
 */
function instanceServer(opts: {
  roster: Descriptor[];
  peersByHomeId: Record<number, Peer>;
  homeIdByPublicId: Record<string, number>;
  batches: Batch[];
}): FakeTrpc {
  return fakeTrpc({
    'channels.getVisibleUserDescriptors': () => opts.roster,
    'users.resolveByDescriptor': (input) => {
      const { publicId } = input as { publicId: string };
      return { id: opts.homeIdByPublicId[publicId] ?? null };
    },
    'e2ee.getPreKeyBundle': (input) => {
      const { userId } = input as { userId: number };
      return opts.peersByHomeId[userId]?.bundle() ?? null;
    },
    'e2ee.getIdentityPublicKey': (input) => {
      const { userId } = input as { userId: number };
      return opts.peersByHomeId[userId]?.identityPublicKey ?? null;
    },
    'e2ee.distributeSenderKeysBatch': (input) => {
      opts.batches.push(input as Batch);
    },
    'e2ee.listMyE2eeChannelIds': () => [CHANNEL_ID]
  });
}

let restoreClients: (() => void) | null = null;

beforeEach(async () => {
  await installHomeIdentity();
  invalidateChannelMembers();
});

afterEach(async () => {
  restoreClients?.();
  restoreClients = null;
  resetInstanceState();
  invalidateChannelMembers();
  await signalStore.clearAll();
  await getStoreForInstance(HOST_DOMAIN).clearAll();
});

describe('member roster freshness (join after first message)', () => {
  test('a member who joins later is SKDMed on the next ensure pass', async () => {
    const alice = await createPeer();
    const bob = await createPeer();
    const roster: Descriptor[] = [
      { id: ME_HOME, name: 'me', publicId: 'pub-me', instanceDomain: HOME_DOMAIN },
      { id: 2, name: 'alice', publicId: 'pub-alice', instanceDomain: HOME_DOMAIN }
    ];
    const batches: Batch[] = [];
    const home = instanceServer({
      roster,
      peersByHomeId: { 2: alice, 4: bob },
      homeIdByPublicId: { 'pub-me': ME_HOME, 'pub-alice': 2, 'pub-bob': 4 },
      batches
    });
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });

    const instance = (await getHomeE2eeInstance()) as E2eeInstance;
    expect(instance).not.toBeNull();
    expect(instance.ownUserId).toBe(ME_HOME);

    // First send: roster fetched, Alice gets the chain.
    await ensureChannelSenderKey(CHANNEL_ID, instance);
    expect(home.callsTo('channels.getVisibleUserDescriptors')).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(batches[0].distributions.map((d) => d.toPublicId)).toEqual([
      'pub-alice'
    ]);
    const aliceSkdm = JSON.parse(
      await alice.decryptFrom(ME_HOME, batches[0].distributions[0].distributionMessage)
    ) as SenderKeyDistribution;
    expect(aliceSkdm.senderKeyId).toBe(1);

    // Bob joins. The join path must refetch the roster and target him —
    // with the session-lifetime cache he was computed out of the stale
    // list forever.
    roster.push({ id: 4, name: 'bob', publicId: 'pub-bob', instanceDomain: HOME_DOMAIN });
    await distributeSenderKeysToOnlineMember(4, instance, [CHANNEL_ID]);

    expect(home.callsTo('channels.getVisibleUserDescriptors')).toHaveLength(2);
    expect(batches).toHaveLength(2);
    expect(batches[1].distributions.map((d) => d.toPublicId)).toEqual([
      'pub-bob'
    ]);
    const bobSkdm = JSON.parse(
      await bob.decryptFrom(ME_HOME, batches[1].distributions[0].distributionMessage)
    ) as SenderKeyDistribution;
    // Same chain — a join is not a rotation.
    expect(bobSkdm.senderKeyId).toBe(1);
    expect(bobSkdm.chainKey).toBe(aliceSkdm.chainKey);
  });

  test('the roster is cached briefly and dropped on invalidation', async () => {
    const alice = await createPeer();
    const batches: Batch[] = [];
    const home = instanceServer({
      roster: [
        { id: ME_HOME, name: 'me', publicId: 'pub-me', instanceDomain: HOME_DOMAIN },
        { id: 2, name: 'alice', publicId: 'pub-alice', instanceDomain: HOME_DOMAIN }
      ],
      peersByHomeId: { 2: alice },
      homeIdByPublicId: { 'pub-me': ME_HOME, 'pub-alice': 2 },
      batches
    });
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const instance = (await getHomeE2eeInstance()) as E2eeInstance;

    await ensureChannelSenderKey(CHANNEL_ID, instance);
    await ensureChannelSenderKey(CHANNEL_ID, instance);
    expect(home.callsTo('channels.getVisibleUserDescriptors')).toHaveLength(1);
    // Alice already holds the chain: no second batch.
    expect(batches).toHaveLength(1);

    invalidateChannelMembers(CHANNEL_ID);
    await ensureChannelSenderKey(CHANNEL_ID, instance);
    expect(home.callsTo('channels.getVisibleUserDescriptors')).toHaveLength(2);
  });
});

describe('home and federated host are distinct instances', () => {
  test('same channel id on both runs two passes into two stores under two own ids', async () => {
    const alice = await createPeer(); // home peer, home id 2
    const carol = await createPeer(); // host-local peer, shadow 33 on home
    const homeBatches: Batch[] = [];
    const hostBatches: Batch[] = [];
    const peersByHomeId = { 2: alice, 33: carol };
    const homeIdByPublicId = { 'pub-me': ME_HOME, 'pub-alice': 2, 'pub-carol': 33 };

    const home = instanceServer({
      roster: [
        { id: ME_HOME, name: 'me', publicId: 'pub-me', instanceDomain: HOME_DOMAIN },
        { id: 2, name: 'alice', publicId: 'pub-alice', instanceDomain: HOME_DOMAIN }
      ],
      peersByHomeId,
      homeIdByPublicId,
      batches: homeBatches
    });
    // The host's roster speaks host ids: we are 5 there, Carol is 9.
    const host = instanceServer({
      roster: [
        { id: ME_HOST, name: 'me', publicId: 'pub-me', instanceDomain: HOME_DOMAIN },
        { id: 9, name: 'carol', publicId: 'pub-carol', instanceDomain: HOST_DOMAIN }
      ],
      peersByHomeId,
      homeIdByPublicId,
      batches: hostBatches
    });
    restoreClients = installClients({ home, remotes: { [HOST_DOMAIN]: host } });
    setInstanceState({
      homeOwnUserId: ME_HOME,
      activeDomain: HOST_DOMAIN,
      activeOwnUserId: ME_HOST,
      federatedServers: [federatedEntry(HOST_DOMAIN, ME_HOST)]
    });
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    await hostStore.copyIdentityFrom(signalStore);

    const homeInstance = (await getHomeE2eeInstance()) as E2eeInstance;
    const hostInstance = (await getActiveE2eeInstance()) as E2eeInstance;
    // The ambient own id is the host's view of us; the home instance
    // must not pick it up while the host is in focus.
    expect(homeInstance.ownUserId).toBe(ME_HOME);
    expect(homeInstance.domain).toBeNull();
    expect(hostInstance.domain).toBe(HOST_DOMAIN);
    expect(hostInstance.ownUserId).toBe(ME_HOST);

    await Promise.all([
      ensureChannelSenderKey(CHANNEL_ID, homeInstance),
      ensureChannelSenderKey(CHANNEL_ID, hostInstance)
    ]);

    // Both passes ran (the in-flight map no longer collapses home
    // channel 3 onto host channel 3), each on its own client.
    expect(homeBatches).toHaveLength(1);
    expect(hostBatches).toHaveLength(1);
    expect(homeBatches[0].distributions.map((d) => d.toPublicId)).toEqual(['pub-alice']);
    expect(hostBatches[0].distributions.map((d) => d.toPublicId)).toEqual(['pub-carol']);
    expect(home.callsTo('channels.getVisibleUserDescriptors')).toHaveLength(1);
    expect(host.callsTo('channels.getVisibleUserDescriptors')).toHaveLength(1);
    // Descriptor resolution always goes through home, never the host.
    expect(host.callsTo('users.resolveByDescriptor')).toHaveLength(0);
    expect(home.callsTo('users.resolveByDescriptor').length).toBeGreaterThanOrEqual(4);

    // Chains live in the right store under the right id — the id the
    // next normal send on that instance looks up.
    expect(await signalStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOME)).toBe(1);
    expect(await signalStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOST)).toBeUndefined();
    expect(await hostStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOST)).toBe(1);
    expect(await hostStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOME)).toBeUndefined();

    // Carol opens the host SKDM under the address the HOME resolver
    // gave us for her — the libsignal address shared by every store.
    const carolSkdm = JSON.parse(
      await carol.decryptFrom(ME_HOME, hostBatches[0].distributions[0].distributionMessage)
    ) as SenderKeyDistribution;
    expect(carolSkdm.senderKeyId).toBe(1);
    const aliceSkdm = JSON.parse(
      await alice.decryptFrom(ME_HOME, homeBatches[0].distributions[0].distributionMessage)
    ) as SenderKeyDistribution;
    expect(aliceSkdm.chainKey).not.toBe(carolSkdm.chainKey);
  });
});
