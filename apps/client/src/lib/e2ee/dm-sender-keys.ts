/**
 * DM-group sender-key glue. Symmetric to `sender-keys.ts` but scoped
 * to DM channels. The IDB keying uses `kind = 'dm'` so a DM channel
 * id and a server channel id with the same numeric value can never
 * collide. Group DMs always live on the home instance, so all chain
 * state is in the home `signalStore` (no per-instance fanout).
 *
 * No `cryptoKeyCache` / `clearDmCryptoKeyCache` exports anymore
 * (Phase A holdover) — chains hold their own forward state.
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

const KIND: ChainKind = 'dm';

function aad(
  dmChannelId: number,
  senderId: number
): Omit<AadContext, 'senderKeyId'> {
  return { kind: KIND, scopeId: dmChannelId, senderId };
}

function b64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(b64));
}

export async function getOrCreateOutboundDmChain(
  dmChannelId: number,
  ownUserId: number,
  store: SignalProtocolStore = signalStore
): Promise<SenderKeyChain> {
  const senderKeyId = await store.getOwnSenderKeyId(
    KIND,
    dmChannelId,
    ownUserId
  );
  if (senderKeyId !== undefined) {
    const data = await store.getChain(
      KIND,
      dmChannelId,
      ownUserId,
      senderKeyId
    );
    if (data) return SenderKeyChain.fromIdb(data);
  }
  const chain = await SenderKeyChain.createOutbound(1);
  await store.storeChain(KIND, dmChannelId, ownUserId, 1, chain.toIdb());
  await store.setOwnSenderKeyId(KIND, dmChannelId, ownUserId, 1);
  return chain;
}

export async function rotateOutboundDmChain(
  dmChannelId: number,
  ownUserId: number,
  store: SignalProtocolStore = signalStore
): Promise<SenderKeyChain> {
  const current =
    (await store.getOwnSenderKeyId(KIND, dmChannelId, ownUserId)) ?? 0;
  const nextId = current + 1;
  const chain = await SenderKeyChain.createOutbound(nextId);
  await store.storeChain(
    KIND,
    dmChannelId,
    ownUserId,
    nextId,
    chain.toIdb()
  );
  await store.setOwnSenderKeyId(KIND, dmChannelId, ownUserId, nextId);
  return chain;
}

export async function acceptInboundDmChain(
  dmChannelId: number,
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
    dmChannelId,
    fromUserId,
    distribution.senderKeyId,
    chain.toIdb()
  );
}

export async function encryptDmGroupMessage(
  dmChannelId: number,
  ownUserId: number,
  plaintext: string,
  store: SignalProtocolStore = signalStore
): Promise<string> {
  const senderKeyId = await store.getOwnSenderKeyId(
    KIND,
    dmChannelId,
    ownUserId
  );
  if (senderKeyId === undefined) {
    throw new Error(
      `No outbound chain for DM channel ${dmChannelId} — call ensureDmGroupSenderKey first`
    );
  }
  const data = await store.getChain(
    KIND,
    dmChannelId,
    ownUserId,
    senderKeyId
  );
  if (!data) {
    throw new Error(
      `Outbound chain missing in IDB for dmChannel=${dmChannelId} senderKeyId=${senderKeyId}`
    );
  }
  const chain = SenderKeyChain.fromIdb(data);
  const wire = await chain.encrypt(plaintext, aad(dmChannelId, ownUserId));
  await store.storeChain(
    KIND,
    dmChannelId,
    ownUserId,
    senderKeyId,
    chain.toIdb()
  );
  return wire;
}

export class MissingDmChainError extends Error {
  constructor(
    public readonly dmChannelId: number,
    public readonly fromUserId: number,
    public readonly senderKeyId: number
  ) {
    super(
      `No DM chain for channel=${dmChannelId} sender=${fromUserId} senderKeyId=${senderKeyId}`
    );
    this.name = 'MissingDmChainError';
  }
}

export async function decryptDmGroupMessage(
  dmChannelId: number,
  fromUserId: number,
  wire: string,
  store: SignalProtocolStore = signalStore
): Promise<string> {
  const decoded = decodeWire(wire);
  const data = await store.getChain(
    KIND,
    dmChannelId,
    fromUserId,
    decoded.senderKeyId
  );
  if (!data) {
    throw new MissingDmChainError(
      dmChannelId,
      fromUserId,
      decoded.senderKeyId
    );
  }
  const chain = SenderKeyChain.fromIdb(data);
  const plaintext = await chain.decrypt(wire, aad(dmChannelId, fromUserId));
  await store.storeChain(
    KIND,
    dmChannelId,
    fromUserId,
    decoded.senderKeyId,
    chain.toIdb()
  );
  return plaintext;
}

export async function hasDmChain(
  dmChannelId: number,
  fromUserId: number,
  senderKeyId: number,
  store: SignalProtocolStore = signalStore
): Promise<boolean> {
  const data = await store.getChain(
    KIND,
    dmChannelId,
    fromUserId,
    senderKeyId
  );
  return !!data;
}
