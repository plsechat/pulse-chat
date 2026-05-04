/**
 * Channel sender-key glue. Phase B replaces the static AES-256-GCM
 * keys we shipped in Phase A with full Signal-style ratcheted chains
 * (see `sender-key-chain.ts` for the protocol). This module is a
 * thin persistence layer on top of `SenderKeyChain` — it loads chain
 * state from IDB, hands it to the chain, and stores the advanced
 * state back. It does not talk to the network — distribution flows
 * through `index.ts` (`ensureChannelSenderKey`,
 * `processIncomingSenderKey`, `fetchAndProcessPendingSenderKeys`).
 *
 * No-cache surface area: the chain owns its own forward state in
 * IDB; CryptoKeys are derived per-message from the chainKey HKDF
 * step and not re-imported from a base64 string the way the Phase A
 * code did. The Phase A `cryptoKeyCache` / `clearCryptoKeyCache`
 * exports are gone — consumers should not need to invalidate any
 * external cache when restoring keys.
 */

import { signalStore, type SignalProtocolStore } from './store';
import {
  decodeWire,
  SenderKeyChain,
  type AadContext,
  type ChainKind,
  type SenderKeyDistribution
} from './sender-key-chain';
import { base64ToArrayBuffer } from './utils';

const KIND: ChainKind = 'channel';

function aad(
  channelId: number,
  senderId: number
): Omit<AadContext, 'senderKeyId'> {
  return { kind: KIND, scopeId: channelId, senderId };
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(b64));
}

/**
 * Get-or-create the latest own outbound chain for (channel, ownUser).
 * If we've never sent in this channel, generates a fresh chain at
 * `senderKeyId = 1`. The caller is responsible for distributing the
 * resulting SKDM (`chain.buildDistribution()`) to remaining members.
 */
export async function getOrCreateOutboundChannelChain(
  channelId: number,
  ownUserId: number,
  store: SignalProtocolStore = signalStore
): Promise<SenderKeyChain> {
  const senderKeyId = await store.getOwnSenderKeyId(
    KIND,
    channelId,
    ownUserId
  );
  if (senderKeyId !== undefined) {
    const data = await store.getChain(
      KIND,
      channelId,
      ownUserId,
      senderKeyId
    );
    if (data) return SenderKeyChain.fromIdb(data);
  }
  const chain = await SenderKeyChain.createOutbound(1);
  await store.storeChain(KIND, channelId, ownUserId, 1, chain.toIdb());
  await store.setOwnSenderKeyId(KIND, channelId, ownUserId, 1);
  return chain;
}

/**
 * Bump senderKeyId and generate a new outbound chain. Used on
 * detected kick/leave (B4 lazy rotation): the kicked member retains
 * keys for the OLD chain, but new messages encrypt under the new
 * chain that no SKDM has been sent to them for. Caller redistributes
 * to remaining members.
 */
export async function rotateOutboundChannelChain(
  channelId: number,
  ownUserId: number,
  store: SignalProtocolStore = signalStore
): Promise<SenderKeyChain> {
  const current =
    (await store.getOwnSenderKeyId(KIND, channelId, ownUserId)) ?? 0;
  const nextId = current + 1;
  const chain = await SenderKeyChain.createOutbound(nextId);
  await store.storeChain(KIND, channelId, ownUserId, nextId, chain.toIdb());
  await store.setOwnSenderKeyId(KIND, channelId, ownUserId, nextId);
  return chain;
}

/**
 * Persist an inbound chain we received via SKDM. Idempotent:
 * receiving the same SKDM twice (a fetchPending retry, an explicit
 * re-distribute after peer reconnect) is safe — second call
 * overwrites with the same state, which won't break already-cached
 * `lastSeen` because peers never SKDM the same iteration twice.
 */
export async function acceptInboundChannelChain(
  channelId: number,
  fromUserId: number,
  distribution: SenderKeyDistribution,
  store: SignalProtocolStore = signalStore
): Promise<void> {
  const chain = SenderKeyChain.acceptInbound(
    distribution.senderKeyId,
    b64ToBytes(distribution.chainKey),
    distribution.iteration,
    b64ToBytes(distribution.signingPublicKey)
  );
  await store.storeChain(
    KIND,
    channelId,
    fromUserId,
    distribution.senderKeyId,
    chain.toIdb()
  );
}

/**
 * Encrypt a channel message under our latest own chain. Persists
 * the advanced chain state on success. Throws if no outbound chain
 * exists yet — caller must run `ensureChannelSenderKey` first.
 */
export async function encryptChannelMessage(
  channelId: number,
  ownUserId: number,
  plaintext: string,
  store: SignalProtocolStore = signalStore
): Promise<string> {
  const senderKeyId = await store.getOwnSenderKeyId(
    KIND,
    channelId,
    ownUserId
  );
  if (senderKeyId === undefined) {
    throw new Error(
      `No outbound chain for channel ${channelId} — call ensureChannelSenderKey first`
    );
  }
  const data = await store.getChain(
    KIND,
    channelId,
    ownUserId,
    senderKeyId
  );
  if (!data) {
    throw new Error(
      `Outbound chain missing in IDB for channel=${channelId} senderKeyId=${senderKeyId}`
    );
  }
  const chain = SenderKeyChain.fromIdb(data);
  const wire = await chain.encrypt(plaintext, aad(channelId, ownUserId));
  await store.storeChain(
    KIND,
    channelId,
    ownUserId,
    senderKeyId,
    chain.toIdb()
  );
  return wire;
}

/**
 * Decrypt a channel message wire. Loads the chain at the senderKeyId
 * embedded in the wire — if missing throws `MissingChainError` so the
 * caller can fetch pending SKDMs and retry. Persists advanced chain
 * state (lastSeen, skippedKeys cache, ratcheted chainKey) on success.
 */
export class MissingChainError extends Error {
  constructor(
    public readonly channelId: number,
    public readonly fromUserId: number,
    public readonly senderKeyId: number
  ) {
    super(
      `No chain for channel=${channelId} sender=${fromUserId} senderKeyId=${senderKeyId}`
    );
    this.name = 'MissingChainError';
  }
}

export async function decryptChannelMessage(
  channelId: number,
  fromUserId: number,
  wire: string,
  store: SignalProtocolStore = signalStore
): Promise<string> {
  const decoded = decodeWire(wire);
  const data = await store.getChain(
    KIND,
    channelId,
    fromUserId,
    decoded.senderKeyId
  );
  if (!data) {
    throw new MissingChainError(channelId, fromUserId, decoded.senderKeyId);
  }
  const chain = SenderKeyChain.fromIdb(data);
  const plaintext = await chain.decrypt(wire, aad(channelId, fromUserId));
  await store.storeChain(
    KIND,
    channelId,
    fromUserId,
    decoded.senderKeyId,
    chain.toIdb()
  );
  return plaintext;
}

/**
 * Truthy when an inbound chain exists for (channel, fromUserId,
 * senderKeyId). The decrypt-retry path uses this to bail before
 * spinning on an SKDM that the sender simply hasn't issued yet.
 */
export async function hasChannelChain(
  channelId: number,
  fromUserId: number,
  senderKeyId: number,
  store: SignalProtocolStore = signalStore
): Promise<boolean> {
  const data = await store.getChain(
    KIND,
    channelId,
    fromUserId,
    senderKeyId
  );
  return !!data;
}
