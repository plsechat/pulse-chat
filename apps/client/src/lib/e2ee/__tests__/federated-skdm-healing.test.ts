/**
 * Federated channel SKDMs are encrypted to the keys we published on
 * HOME. While a federated host is in focus the pending pull must open
 * them with the home store and write the chain into the host store —
 * the host store's prekeys are a different set and can never open
 * them. The same pull is what the host connect/reconnect path runs,
 * so a wake-up that never arrived is reconciled.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/federated-skdm-healing.test.ts
 */

import './instance-dom-stubs';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  createPeer,
  encryptFromPeer,
  fakeTrpc,
  federatedEntry,
  installModuleMocks,
  installClients,
  installHomeIdentity,
  resetInstanceState,
  setInstanceState,
  type Peer
} from './instance-harness';
import { SenderKeyChain } from '../sender-key-chain';

// Re-assert the harness mocks (another file may have replaced them since
// the harness first loaded), then import the lib — a static import would
// bind index.ts to whatever modules were registered first.
installModuleMocks();
const {
  fetchAndProcessFederatedSenderKeys,
  fetchAndProcessPendingSenderKeys,
  invalidateChannelMembers
} = await import('..');
const { hasChannelChain } = await import('../sender-keys');
const { hasSession } = await import('../signal-protocol');
const { getStoreForInstance, signalStore } = await import('../store');

const HOST_DOMAIN = 'host.test';
const HOST_CHANNEL_ID = 3;
const ME_HOME = 10;
const ME_HOST = 5;
/** Sender Sam is local to the host: host id 7, shadow 77 on our home. */
const SAM_HOST = 7;
const SAM_HOME_SHADOW = 77;

type PendingRow = {
  id: number;
  channelId: number;
  senderKeyId: number;
  fromUserId: number;
  distributionMessage: string;
  fromHomePublicId: string | null;
  fromInstanceDomain: string | null;
};

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
  await signalStore.clearAll();
  await getStoreForInstance(HOST_DOMAIN).clearAll();
});

/** Sam SKDMs us: X3DH to our HOME bundle, addressed by his id for us. */
async function samsSkdm(sam: Peer): Promise<{ row: PendingRow }> {
  const chain = await SenderKeyChain.createOutbound(1);
  const distribution = chain.buildDistribution();
  const ciphertext = await encryptFromPeer(sam, me, 55, JSON.stringify(distribution));
  return {
    row: {
      id: 1,
      channelId: HOST_CHANNEL_ID,
      senderKeyId: 1,
      fromUserId: SAM_HOST,
      distributionMessage: ciphertext,
      fromHomePublicId: 'pub-sam',
      fromInstanceDomain: null
    }
  };
}

function setup(rows: PendingRow[]) {
  const acked: number[][] = [];
  const home = fakeTrpc({
    'users.resolveByDescriptor': (input) => {
      const { publicId, instanceDomain } = input as {
        publicId: string;
        instanceDomain: string;
      };
      // A host-local sender collapses to the host's own domain.
      return {
        id: publicId === 'pub-sam' && instanceDomain === HOST_DOMAIN ? SAM_HOME_SHADOW : null
      };
    }
  });
  const host = fakeTrpc({
    'e2ee.getPendingSenderKeys': () => rows,
    'e2ee.acknowledgeSenderKeys': (input) => {
      acked.push((input as { ids: number[] }).ids);
    }
  });
  restoreClients = installClients({ home, remotes: { [HOST_DOMAIN]: host } });
  setInstanceState({
    homeOwnUserId: ME_HOME,
    activeDomain: HOST_DOMAIN,
    activeOwnUserId: ME_HOST,
    federatedServers: [federatedEntry(HOST_DOMAIN, ME_HOST)]
  });
  return { home, host, acked };
}

describe('pending pull while a federated host is in focus', () => {
  test('a host-local sender row is opened with the home store and lands in the host store', async () => {
    const sam = await createPeer();
    const { row } = await samsSkdm(sam);
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    // The host store has its own, separate key set.
    await createPeer(hostStore);
    const { home, host, acked } = setup([row]);

    await fetchAndProcessPendingSenderKeys(HOST_CHANNEL_ID);

    // Resolved on home, chain keyed by the HOST ids the message path
    // looks up, decrypt session in the HOME store at the shadow address.
    expect(home.callsTo('users.resolveByDescriptor')).toHaveLength(1);
    expect(await hasChannelChain(HOST_CHANNEL_ID, SAM_HOST, 1, hostStore)).toBe(true);
    expect(await hasChannelChain(HOST_CHANNEL_ID, SAM_HOST, 1, signalStore)).toBe(false);
    expect(await hasSession(SAM_HOME_SHADOW, signalStore)).toBe(true);
    expect(await hasSession(SAM_HOME_SHADOW, hostStore)).toBe(false);
    expect(await hasSession(SAM_HOST, hostStore)).toBe(false);
    expect(acked).toEqual([[1]]);
    expect(host.callsTo('e2ee.getPendingSenderKeys')[0].input).toEqual({
      channelId: HOST_CHANNEL_ID
    });
  });

  test('a row the host store cannot open is not acked', async () => {
    const sam = await createPeer();
    const { row } = await samsSkdm(sam);
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    await createPeer(hostStore);
    // Pre-E1 shape: no publicId, so the federated path cannot run
    // and the host-store decrypt fails — the row must stay pending.
    const { acked } = setup([{ ...row, fromHomePublicId: null }]);

    await fetchAndProcessPendingSenderKeys(HOST_CHANNEL_ID);

    expect(await hasChannelChain(HOST_CHANNEL_ID, SAM_HOST, 1, hostStore)).toBe(false);
    expect(acked).toEqual([]);
  });
});

describe('reconnect reconciliation', () => {
  test('fetchAndProcessFederatedSenderKeys pulls, opens and acks; concurrent calls share one pull', async () => {
    const sam = await createPeer();
    const { row } = await samsSkdm(sam);
    const hostStore = getStoreForInstance(HOST_DOMAIN);
    const { host, acked } = setup([row]);

    await Promise.all([
      fetchAndProcessFederatedSenderKeys(HOST_DOMAIN),
      fetchAndProcessFederatedSenderKeys(HOST_DOMAIN)
    ]);

    expect(host.callsTo('e2ee.getPendingSenderKeys')).toHaveLength(1);
    expect(await hasChannelChain(HOST_CHANNEL_ID, SAM_HOST, 1, hostStore)).toBe(true);
    expect(acked).toEqual([[1]]);
  });

  test('is a no-op when the host is not connected', async () => {
    const { host } = setup([]);
    restoreClients?.();
    restoreClients = installClients({ home: fakeTrpc({}), remotes: {} });

    await fetchAndProcessFederatedSenderKeys(HOST_DOMAIN);
    expect(host.calls).toHaveLength(0);
  });
});
