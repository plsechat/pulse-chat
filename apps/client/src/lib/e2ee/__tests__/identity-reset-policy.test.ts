/**
 * handlePeerIdentityReset — instance routing and the D11 TOFU policy.
 *
 *  - A reset received on HOME while a federated server is in focus
 *    still queries home for the new key, keys the re-distributed chain
 *    by our HOME id and writes it into the home store.
 *  - `channelIds` on the payload limits the re-key to those channels;
 *    without it the full list is fetched.
 *  - `tofu` pin: silent re-pin (the e2e "silent re-pin" expectation).
 *  - `manual` pin: nothing is re-pinned or redistributed until the
 *    user accepts in the identity-changed dialog; a block leaves the
 *    old pin in place.
 *  - Our own reset echo does not reload the tab when the server holds
 *    the identity this device already has.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/identity-reset-policy.test.ts
 */

import './instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createPeer,
  decideIdentityChange,
  fakeTrpc,
  federatedEntry,
  identityChangeRequests,
  installModuleMocks,
  installClients,
  installHomeIdentity,
  resetInstanceState,
  setInstanceState,
  waitFor,
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
  ensureChannelSenderKey,
  getHomeE2eeInstance,
  handlePeerIdentityReset,
  invalidateChannelMembers
} = await import('..');
const { hasSession } = await import('../signal-protocol');
const { getStoreForInstance, signalStore } = await import('../store');

const HOME_DOMAIN = 'home.test';
const HOST_DOMAIN = 'host.test';
const CHANNEL_ID = 3;
const OTHER_CHANNEL_ID = 8;
const ME_HOME = 10;
const ME_HOST = 5;
const ALICE = 2;

type Batch = {
  channelId: number;
  senderKeyId: number;
  distributions: { toPublicId: string; distributionMessage: string }[];
};

/** Home server with Alice as the only other member of two channels. */
function homeServer(alice: { current: Peer }, batches: Batch[]): FakeTrpc {
  return fakeTrpc({
    'channels.getVisibleUserDescriptors': () => [
      { id: ME_HOME, name: 'me', publicId: 'pub-me', instanceDomain: HOME_DOMAIN },
      { id: ALICE, name: 'alice', publicId: 'pub-alice', instanceDomain: HOME_DOMAIN }
    ],
    'users.resolveByDescriptor': (input) => {
      const { publicId } = input as { publicId: string };
      return { id: publicId === 'pub-me' ? ME_HOME : publicId === 'pub-alice' ? ALICE : null };
    },
    'e2ee.getPreKeyBundle': () => alice.current.bundle(),
    'e2ee.getIdentityPublicKey': () => alice.current.identityPublicKey,
    'e2ee.distributeSenderKeysBatch': (input) => {
      batches.push(input as Batch);
    },
    'e2ee.listMyE2eeChannelIds': () => [CHANNEL_ID, OTHER_CHANNEL_ID]
  });
}

let restoreClients: (() => void) | null = null;
let me: Peer;

beforeEach(async () => {
  me = await installHomeIdentity();
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

async function distributedTo(peer: Peer, batch: Batch): Promise<SenderKeyDistribution> {
  return JSON.parse(
    await peer.decryptFrom(ME_HOME, batch.distributions[0].distributionMessage)
  ) as SenderKeyDistribution;
}

describe('home reset while a federated server is in focus', () => {
  test('re-keys home channels in the home store under the home id', async () => {
    const alice = { current: await createPeer() };
    const batches: Batch[] = [];
    const home = homeServer(alice, batches);
    const host = fakeTrpc({});
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
    await ensureChannelSenderKey(CHANNEL_ID, homeInstance);
    expect(batches).toHaveLength(1);
    const before = await distributedTo(alice.current, batches[0]);

    // Alice rotates. The broadcast lands on the home socket with a home id.
    const rotated = await createPeer();
    alice.current = rotated;
    await handlePeerIdentityReset(ALICE, homeInstance, {
      channelIds: [CHANNEL_ID]
    });

    // The new key was fetched from HOME, not the host in focus.
    expect(home.callsTo('e2ee.getIdentityPublicKey')).toHaveLength(1);
    expect(host.calls).toHaveLength(0);
    // Named channels only — no list fetch.
    expect(home.callsTo('e2ee.listMyE2eeChannelIds')).toHaveLength(0);

    // Re-SKDM of the SAME chain (a peer reset is not our rotation),
    // readable by the rotated identity, keyed by our home id in the
    // home store; the host store is untouched.
    expect(batches).toHaveLength(2);
    expect(batches[1].channelId).toBe(CHANNEL_ID);
    const after = await distributedTo(rotated, batches[1]);
    expect(after.senderKeyId).toBe(before.senderKeyId);
    expect(after.chainKey).toBe(before.chainKey);
    expect(await signalStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOME)).toBe(1);
    expect(await signalStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOST)).toBeUndefined();
    expect(await hostStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOST)).toBeUndefined();
    expect(await hostStore.getOwnSenderKeyId('channel', CHANNEL_ID, ME_HOME)).toBeUndefined();
    // Session rebuilt under the new identity in the home store.
    expect(await hasSession(ALICE, signalStore)).toBe(true);
    expect((await signalStore.getVerifiedIdentity(ALICE))?.identityPublicKey).toBe(
      rotated.identityPublicKey
    );
  });

  test('without channelIds the full list is fetched; an empty list re-keys nothing', async () => {
    const alice = { current: await createPeer() };
    const batches: Batch[] = [];
    const home = homeServer(alice, batches);
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const homeInstance = (await getHomeE2eeInstance()) as E2eeInstance;

    await handlePeerIdentityReset(ALICE, homeInstance);
    expect(home.callsTo('e2ee.listMyE2eeChannelIds')).toHaveLength(1);
    expect(batches.map((b) => b.channelId).sort()).toEqual([CHANNEL_ID, OTHER_CHANNEL_ID]);

    const count = batches.length;
    await handlePeerIdentityReset(ALICE, homeInstance, { channelIds: [] });
    expect(home.callsTo('e2ee.listMyE2eeChannelIds')).toHaveLength(1);
    expect(batches).toHaveLength(count);
  });
});

describe('TOFU policy on a reset broadcast (D11)', () => {
  test('a tofu pin is replaced silently and the chain is redistributed', async () => {
    const alice = { current: await createPeer() };
    const batches: Batch[] = [];
    const home = homeServer(alice, batches);
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const homeInstance = (await getHomeE2eeInstance()) as E2eeInstance;
    await ensureChannelSenderKey(CHANNEL_ID, homeInstance);
    // The first session pinned Alice under TOFU.
    expect((await signalStore.getVerifiedIdentity(ALICE))?.verifiedMethod).toBe('tofu');

    const rotated = await createPeer();
    alice.current = rotated;
    await handlePeerIdentityReset(ALICE, homeInstance, {
      newIdentityPublicKey: rotated.identityPublicKey,
      channelIds: [CHANNEL_ID]
    });

    expect(identityChangeRequests).toHaveLength(0);
    const pin = await signalStore.getVerifiedIdentity(ALICE);
    expect(pin?.identityPublicKey).toBe(rotated.identityPublicKey);
    expect(pin?.verifiedMethod).toBe('tofu');
    expect(pin?.acceptedChangeAt).toBeDefined();
    expect(batches).toHaveLength(2);
    expect((await distributedTo(rotated, batches[1])).senderKeyId).toBe(1);
  });

  test('a manual pin raises the dialog; accept re-pins and redistributes', async () => {
    const alice = { current: await createPeer() };
    const batches: Batch[] = [];
    const home = homeServer(alice, batches);
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const homeInstance = (await getHomeE2eeInstance()) as E2eeInstance;
    await ensureChannelSenderKey(CHANNEL_ID, homeInstance);
    const original = alice.current.identityPublicKey;
    await signalStore.markIdentityManual(ALICE, original);

    const rotated = await createPeer();
    alice.current = rotated;
    const pending = handlePeerIdentityReset(ALICE, homeInstance, {
      newIdentityPublicKey: rotated.identityPublicKey,
      channelIds: [CHANNEL_ID]
    });

    await waitFor(() => identityChangeRequests.length === 1);
    expect(identityChangeRequests[0]).toMatchObject({
      userId: ALICE,
      newIdentityPublicKey: rotated.identityPublicKey,
      store: signalStore
    });
    // Nothing moved while the user decides: the manual pin stands, no
    // re-SKDM went out.
    const pinWhileOpen = await signalStore.getVerifiedIdentity(ALICE);
    expect(pinWhileOpen?.verifiedMethod).toBe('manual');
    expect(pinWhileOpen?.identityPublicKey).toBe(original);
    expect(batches).toHaveLength(1);

    await decideIdentityChange(ALICE, 'accept');
    await pending;

    const pin = await signalStore.getVerifiedIdentity(ALICE);
    expect(pin?.identityPublicKey).toBe(rotated.identityPublicKey);
    expect(pin?.verifiedMethod).toBe('tofu');
    expect(batches).toHaveLength(2);
    expect((await distributedTo(rotated, batches[1])).senderKeyId).toBe(1);
  });

  test('a manual pin plus block leaves the old pin and sends nothing', async () => {
    const alice = { current: await createPeer() };
    const batches: Batch[] = [];
    const home = homeServer(alice, batches);
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const homeInstance = (await getHomeE2eeInstance()) as E2eeInstance;
    await ensureChannelSenderKey(CHANNEL_ID, homeInstance);
    const original = alice.current.identityPublicKey;
    await signalStore.markIdentityManual(ALICE, original);

    const rotated = await createPeer();
    alice.current = rotated;
    const pending = handlePeerIdentityReset(ALICE, homeInstance, {
      newIdentityPublicKey: rotated.identityPublicKey,
      channelIds: [CHANNEL_ID]
    });
    await waitFor(() => identityChangeRequests.length === 1);
    await decideIdentityChange(ALICE, 'block');
    await pending;

    const pin = await signalStore.getVerifiedIdentity(ALICE);
    expect(pin?.verifiedMethod).toBe('manual');
    expect(pin?.identityPublicKey).toBe(original);
    expect(batches).toHaveLength(1);
    // The stale session was not touched either — the old pin still
    // guards it.
    expect(await hasSession(ALICE, signalStore)).toBe(true);
    expect(home.callsTo('e2ee.listMyE2eeChannelIds')).toHaveLength(0);
  });

  test('a manual pin that still matches the announced key proceeds silently', async () => {
    const alice = { current: await createPeer() };
    const batches: Batch[] = [];
    const home = homeServer(alice, batches);
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const homeInstance = (await getHomeE2eeInstance()) as E2eeInstance;
    await ensureChannelSenderKey(CHANNEL_ID, homeInstance);
    await signalStore.markIdentityManual(ALICE, alice.current.identityPublicKey);

    // A restore to the same identity: peers wiped their sessions, so
    // ours must be rebuilt, but the pin is still right.
    await handlePeerIdentityReset(ALICE, homeInstance, {
      newIdentityPublicKey: alice.current.identityPublicKey,
      channelIds: [CHANNEL_ID]
    });

    expect(identityChangeRequests).toHaveLength(0);
    expect((await signalStore.getVerifiedIdentity(ALICE))?.verifiedMethod).toBe('manual');
    expect(batches).toHaveLength(2);
  });
});

describe('own reset echo', () => {
  test('does not reload when the server holds this device’s identity', async () => {
    const home = fakeTrpc({
      'e2ee.getOwnIdentity': () => me.identityPublicKey
    });
    restoreClients = installClients({ home });
    setInstanceState({ homeOwnUserId: ME_HOME });
    const homeInstance = (await getHomeE2eeInstance()) as E2eeInstance;

    let reloads = 0;
    const location = window.location as unknown as { reload: () => void };
    const originalReload = location.reload;
    location.reload = () => {
      reloads++;
    };
    try {
      await handlePeerIdentityReset(ME_HOME, homeInstance);
      expect(reloads).toBe(0);

      home.handlers['e2ee.getOwnIdentity'] = () => 'someone-elses-identity';
      await handlePeerIdentityReset(ME_HOME, homeInstance);
      expect(reloads).toBe(1);
    } finally {
      location.reload = originalReload;
    }
    // No peer work for an own-user event.
    expect(home.callsTo('e2ee.listMyE2eeChannelIds')).toHaveLength(0);
  });
});
