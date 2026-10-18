/**
 * initE2EEForInstance — identity parity against the remote, and the
 * order of operations in redistributeOwnSenderKeys for federated legs.
 *
 *  - The remote holding an identity that is neither the instance copy
 *    nor the home identity means another device replaced the account
 *    identity: halt (mismatch event), upload nothing.
 *  - Remote == home != instance copy (restore) and remote == instance
 *    copy != home (regen) both re-register from the home identity.
 *  - After a regen, the federated store is re-synced (identity ==
 *    home, registered on the remote) BEFORE any distribution goes out
 *    on the remote.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/instance-init-guard.test.ts
 */

import './instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { onAppEvent } from '@/lib/events';
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
// Re-assert the harness mocks (another file may have replaced them since
// the harness first loaded), then import the lib — a static import would
// bind index.ts to whatever modules were registered first.
installModuleMocks();
const { initE2EEForInstance, invalidateChannelMembers, redistributeOwnSenderKeys } =
  await import('..');
const { getIdentityPublicKey } = await import('../signal-protocol');
const { getStoreForInstance, signalStore } = await import('../store');

const HOST_DOMAIN = 'host.test';
const ME_HOME = 10;
const ME_HOST = 5;

let restoreClients: (() => void) | null = null;
let me: Peer;
let mismatches = 0;
let offMismatch: () => void;

beforeEach(async () => {
  me = await installHomeIdentity();
  invalidateChannelMembers();
  mismatches = 0;
  offMismatch = onAppEvent('e2ee-identity-mismatch', () => {
    mismatches++;
  });
});

afterEach(async () => {
  offMismatch();
  restoreClients?.();
  restoreClients = null;
  resetInstanceState();
  invalidateChannelMembers();
  await signalStore.clearAll();
  await getStoreForInstance(HOST_DOMAIN).clearAll();
});

function remoteServer(opts: { ownIdentity: () => string | null; preKeyCount?: number }): FakeTrpc {
  return fakeTrpc({
    'e2ee.getOwnIdentity': opts.ownIdentity,
    'e2ee.registerKeys': () => undefined,
    'e2ee.getPreKeyCount': () => opts.preKeyCount ?? 100,
    'e2ee.uploadOneTimePreKeys': () => undefined,
    'e2ee.rotateSignedPreKey': () => undefined
  });
}

const uploads = (remote: FakeTrpc) =>
  remote.calls.filter((c) =>
    ['e2ee.registerKeys', 'e2ee.uploadOneTimePreKeys', 'e2ee.rotateSignedPreKey'].includes(c.path)
  );

describe('initE2EEForInstance identity-parity guard', () => {
  test('remote identity from another device: mismatch event, no uploads', async () => {
    const stranger = await createPeer();
    const remote = remoteServer({ ownIdentity: () => stranger.identityPublicKey });
    restoreClients = installClients({ home: fakeTrpc({}), remotes: { [HOST_DOMAIN]: remote } });
    setInstanceState({ homeOwnUserId: ME_HOME });

    await initE2EEForInstance(HOST_DOMAIN);

    expect(mismatches).toBe(1);
    expect(uploads(remote)).toHaveLength(0);
    expect(await getIdentityPublicKey(getStoreForInstance(HOST_DOMAIN))).toBeNull();
  });

  test('fresh instance store registers the home identity on the remote', async () => {
    const remote = remoteServer({ ownIdentity: () => null });
    restoreClients = installClients({ home: fakeTrpc({}), remotes: { [HOST_DOMAIN]: remote } });
    setInstanceState({ homeOwnUserId: ME_HOME });

    await initE2EEForInstance(HOST_DOMAIN);

    expect(mismatches).toBe(0);
    const registered = remote.callsTo('e2ee.registerKeys');
    expect(registered).toHaveLength(1);
    expect((registered[0].input as { identityPublicKey: string }).identityPublicKey).toBe(
      me.identityPublicKey
    );
    expect(await getIdentityPublicKey(getStoreForInstance(HOST_DOMAIN))).toBe(me.identityPublicKey);
  });

  test('remote == home but the instance copy drifted (restore): re-register', async () => {
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    await createPeer(hostStore); // stale copy of a previous identity
    const remote = remoteServer({ ownIdentity: () => me.identityPublicKey });
    restoreClients = installClients({ home: fakeTrpc({}), remotes: { [HOST_DOMAIN]: remote } });
    setInstanceState({ homeOwnUserId: ME_HOME });

    await initE2EEForInstance(HOST_DOMAIN);

    expect(mismatches).toBe(0);
    expect(remote.callsTo('e2ee.registerKeys')).toHaveLength(1);
    expect(await getIdentityPublicKey(hostStore)).toBe(me.identityPublicKey);
  });

  test('remote == instance copy but home was regenerated: re-register', async () => {
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    const old = await createPeer(hostStore);
    const remote = remoteServer({ ownIdentity: () => old.identityPublicKey });
    restoreClients = installClients({ home: fakeTrpc({}), remotes: { [HOST_DOMAIN]: remote } });
    setInstanceState({ homeOwnUserId: ME_HOME });

    await initE2EEForInstance(HOST_DOMAIN);

    expect(mismatches).toBe(0);
    expect(remote.callsTo('e2ee.registerKeys')).toHaveLength(1);
    expect(await getIdentityPublicKey(hostStore)).toBe(me.identityPublicKey);
  });

  test('everything in sync: only the maintenance checks run', async () => {
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    await hostStore.copyIdentityFrom(signalStore);
    await hostStore.setSignedPreKeyRotatedAt(Date.now());
    const remote = remoteServer({ ownIdentity: () => me.identityPublicKey });
    restoreClients = installClients({ home: fakeTrpc({}), remotes: { [HOST_DOMAIN]: remote } });
    setInstanceState({ homeOwnUserId: ME_HOME });

    await initE2EEForInstance(HOST_DOMAIN);

    expect(mismatches).toBe(0);
    expect(uploads(remote)).toHaveLength(0);
    expect(remote.callsTo('e2ee.getPreKeyCount')).toHaveLength(1);
  });

  test('uses the instance’s own client even when another instance is in focus', async () => {
    const remote = remoteServer({ ownIdentity: () => null });
    const other = fakeTrpc({});
    restoreClients = installClients({
      home: fakeTrpc({}),
      remotes: { [HOST_DOMAIN]: remote, 'other.test': other }
    });
    setInstanceState({ homeOwnUserId: ME_HOME, activeDomain: 'other.test', activeOwnUserId: 9 });

    await initE2EEForInstance(HOST_DOMAIN);

    expect(remote.callsTo('e2ee.registerKeys')).toHaveLength(1);
    expect(other.calls).toHaveLength(0);
  });
});

describe('redistributeOwnSenderKeys after a regen', () => {
  test('re-syncs the federated store before any distribution on the remote', async () => {
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    // The store still carries the OLD identity copy, with a chain
    // distributed under it — exactly the state a regen leaves behind.
    const old = await createPeer(hostStore);
    const carol = await createPeer();
    const identityAtDistribute: (string | null)[] = [];
    const remoteIdentity = { current: old.identityPublicKey };
    const remote = fakeTrpc({
      'e2ee.getOwnIdentity': () => remoteIdentity.current,
      'e2ee.registerKeys': (input) => {
        remoteIdentity.current = (input as { identityPublicKey: string }).identityPublicKey;
      },
      'e2ee.listMyE2eeChannelIds': () => [3],
      'channels.getVisibleUserDescriptors': () => [
        { id: ME_HOST, name: 'me', publicId: 'pub-me', instanceDomain: 'home.test' },
        { id: 9, name: 'carol', publicId: 'pub-carol', instanceDomain: HOST_DOMAIN }
      ],
      'e2ee.distributeSenderKeysBatch': async () => {
        identityAtDistribute.push(await getIdentityPublicKey(hostStore));
      }
    });
    const home = fakeTrpc({
      'e2ee.listMyE2eeChannelIds': () => [],
      'users.resolveByDescriptor': (input) => {
        const { publicId } = input as { publicId: string };
        return { id: publicId === 'pub-me' ? ME_HOME : publicId === 'pub-carol' ? 33 : null };
      },
      'e2ee.getPreKeyBundle': () => carol.bundle(),
      'e2ee.getIdentityPublicKey': () => carol.identityPublicKey
    });
    restoreClients = installClients({ home, remotes: { [HOST_DOMAIN]: remote } });
    setInstanceState({
      homeOwnUserId: ME_HOME,
      federatedServers: [federatedEntry(HOST_DOMAIN, ME_HOST)]
    });

    const failures = await redistributeOwnSenderKeys();

    expect(failures).toEqual([]);
    const order = remote.calls.map((c) => c.path);
    expect(order.indexOf('e2ee.registerKeys')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('e2ee.registerKeys')).toBeLessThan(
      order.indexOf('e2ee.distributeSenderKeysBatch')
    );
    expect(identityAtDistribute).toEqual([me.identityPublicKey]);
    expect(await getIdentityPublicKey(hostStore)).toBe(me.identityPublicKey);
    // The chain Carol received is keyed by our HOST id in the re-synced
    // store, which is what the next send on that host looks up.
    expect(await hostStore.getOwnSenderKeyId('channel', 3, ME_HOST)).toBe(1);
  });

  test('a halted instance is reported, not distributed from', async () => {
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    await createPeer(hostStore);
    const stranger = await createPeer();
    const remote = fakeTrpc({
      'e2ee.getOwnIdentity': () => stranger.identityPublicKey,
      'e2ee.distributeSenderKeysBatch': () => undefined,
      'e2ee.listMyE2eeChannelIds': () => [3]
    });
    const home = fakeTrpc({ 'e2ee.listMyE2eeChannelIds': () => [] });
    restoreClients = installClients({ home, remotes: { [HOST_DOMAIN]: remote } });
    setInstanceState({
      homeOwnUserId: ME_HOME,
      federatedServers: [federatedEntry(HOST_DOMAIN, ME_HOST)]
    });

    const failures = await redistributeOwnSenderKeys();

    expect(failures).toEqual([`federated ${HOST_DOMAIN} (identity not in sync)`]);
    expect(remote.callsTo('e2ee.distributeSenderKeysBatch')).toHaveLength(0);
    expect(mismatches).toBe(1);
  });
});
