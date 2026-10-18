/**
 * Decrypt entry points in lib/e2ee/index.ts:
 *   - pairwise DM decrypt must NOT wipe the session on a bad
 *     ciphertext (the next valid message from the same session still
 *     decrypts);
 *   - a sender-key decrypt whose chain never arrives pulls pending
 *     SKDMs exactly once and fails fast (no wall-clock retry loop);
 *   - a persisted plaintext bound to a different wire (an edit) is
 *     never returned for the new wire.
 *
 * index.ts reaches into Redux, tRPC and the subscription-driven retry
 * module; those are stubbed so the real libsignal + sender-key
 * machinery runs against fake-indexeddb.
 *
 * Run via:
 *   bun test apps/client/src/lib/e2ee/__tests__/decrypt-paths.test.ts
 */

import 'fake-indexeddb/auto';
import { afterAll, describe, expect, mock, test } from 'bun:test';

const getPendingSenderKeys = mock(async () => [] as unknown[]);
const acknowledgeSenderKeys = mock(async () => undefined);
const trpcStub = {
  e2ee: {
    getPendingSenderKeys: { query: getPendingSenderKeys },
    acknowledgeSenderKeys: { mutate: acknowledgeSenderKeys }
  }
};

mock.module('@/features/store', () => ({
  store: {
    // Enough of the root state for the e2ee store's selectors
    // (active instance, own id, and the rosters the TOFU pin consults
    // for the peer's public id).
    getState: () => ({
      app: { activeInstanceDomain: null, homeOwnUserId: 1 },
      server: { ownUserId: 1, users: [] },
      friends: { friends: [] },
      dms: { channels: [] }
    }),
    dispatch: () => undefined,
    subscribe: () => () => undefined
  }
}));
mock.module('@/lib/trpc', () => ({
  getHomeTRPCClient: () => trpcStub,
  getTRPCClient: () => trpcStub
}));
mock.module('../decrypt-retry', () => ({
  retryFailedChannelDecrypts: async () => undefined,
  retryFailedDmDecrypts: async () => undefined
}));
mock.module('../identity-change-dispatch', () => ({
  presentIdentityChange: async () => false,
  UntrustedIdentityError: class UntrustedIdentityError extends Error {}
}));

const { decryptChannelMessage, decryptDmMessage } = await import('../index');
const { signalStore, SignalProtocolStore } = await import('../store');
const {
  buildSession,
  encryptMessage,
  generateKeys
} = await import('../signal-protocol');
const {
  acceptInboundChannelChain,
  encryptChannelMessage: encryptWithChain,
  getOrCreateOutboundChannelChain,
  MissingChainError
} = await import('../sender-keys');
const { clearAllOwnPlaintexts, persistOwnPlaintextById } = await import(
  '../plaintext-cache'
);

// The receiver is always the home singleton (`decryptDmMessage` and
// `getActiveStore()` resolve to it); senders get their own stores.
const RECEIVER_ID = 1;
const SENDER_ID = 2;

afterAll(async () => {
  await signalStore.clearAll();
  await clearAllOwnPlaintexts();
});

describe('pairwise DM decrypt', () => {
  test('a bad ciphertext does not break the session for the next message', async () => {
    const senderStore = new SignalProtocolStore('test-decrypt-paths-sender');
    const receiverKeys = await generateKeys(2, signalStore);
    await generateKeys(2, senderStore);
    await buildSession(
      RECEIVER_ID,
      {
        identityPublicKey: receiverKeys.identityPublicKey,
        registrationId: receiverKeys.registrationId,
        signedPreKey: receiverKeys.signedPreKey,
        oneTimePreKey: receiverKeys.oneTimePreKeys[0]
      },
      senderStore
    );

    const first = await encryptMessage(
      RECEIVER_ID,
      JSON.stringify({ content: 'one' }),
      senderStore
    );
    expect((await decryptDmMessage(SENDER_ID, first)).content).toBe('one');

    const second = await encryptMessage(
      RECEIVER_ID,
      JSON.stringify({ content: 'two' }),
      senderStore
    );
    // Corrupt deliveries of both envelope types: a garbage ratchet
    // message and a garbage pre-key message.
    await expect(
      decryptDmMessage(SENDER_ID, JSON.stringify({ type: 1, body: 'garbage' }))
    ).rejects.toBeDefined();
    await expect(
      decryptDmMessage(SENDER_ID, JSON.stringify({ type: 3, body: 'garbage' }))
    ).rejects.toBeDefined();

    // The session the sender is still ratcheting on must survive.
    expect((await decryptDmMessage(SENDER_ID, second)).content).toBe('two');
    await senderStore.clearAll();
  });
});

describe('channel sender-key decrypt', () => {
  const CHANNEL_ID = 77;

  test('missing chain: one SKDM pull, then MissingChainError, no waiting', async () => {
    const senderStore = new SignalProtocolStore('test-decrypt-paths-sk-1');
    await getOrCreateOutboundChannelChain(CHANNEL_ID, SENDER_ID, senderStore);
    const wire = await encryptWithChain(
      CHANNEL_ID,
      SENDER_ID,
      JSON.stringify({ content: 'never readable' }),
      senderStore
    );

    getPendingSenderKeys.mockClear();
    const started = performance.now();
    await expect(
      decryptChannelMessage(CHANNEL_ID, SENDER_ID, wire, 1001)
    ).rejects.toBeInstanceOf(MissingChainError);
    const elapsed = performance.now() - started;

    expect(getPendingSenderKeys).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeLessThan(100);
    await senderStore.clearAll();
  });

  test('an edited message never resolves to the pre-edit plaintext', async () => {
    const senderStore = new SignalProtocolStore('test-decrypt-paths-sk-2');
    const chain = await getOrCreateOutboundChannelChain(
      CHANNEL_ID,
      SENDER_ID,
      senderStore
    );
    await acceptInboundChannelChain(
      CHANNEL_ID,
      SENDER_ID,
      chain.buildDistribution(),
      signalStore
    );

    const MESSAGE_ID = 2002;
    const scope = { kind: 'channel' as const, instanceDomain: null };
    // What the recipient persisted when it first decrypted the row.
    await persistOwnPlaintextById(
      scope,
      MESSAGE_ID,
      'wire-before-edit',
      JSON.stringify({ content: 'before edit' })
    );

    // The author edits: same id, fresh chain iteration.
    const editedWire = await encryptWithChain(
      CHANNEL_ID,
      SENDER_ID,
      JSON.stringify({ content: 'after edit' }),
      senderStore
    );
    const payload = await decryptChannelMessage(
      CHANNEL_ID,
      SENDER_ID,
      editedWire,
      MESSAGE_ID
    );
    expect(payload.content).toBe('after edit');

    // Re-reading the same wire now comes from the rebound cache row
    // (the chain cannot decrypt the iteration twice).
    const again = await decryptChannelMessage(
      CHANNEL_ID,
      SENDER_ID,
      editedWire,
      MESSAGE_ID
    );
    expect(again.content).toBe('after edit');
    await senderStore.clearAll();
  });
});
