import { openDB, type IDBPDatabase } from 'idb';
import type {
  Direction,
  KeyPairType,
  SessionRecordType,
  StorageType
} from '@privacyresearch/libsignal-protocol-typescript';
import { store as reduxStore } from '@/features/store';
import { clearAllOwnPlaintexts } from './plaintext-cache';
import type {
  ChainKind,
  SerializedChain
} from './sender-key-chain';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

const HOME_DB_NAME = 'pulse-e2ee';
const DB_VERSION = 6;

const STORES = {
  IDENTITY_KEY: 'identityKey',
  REGISTRATION_ID: 'registrationId',
  PRE_KEYS: 'preKeys',
  SIGNED_PRE_KEYS: 'signedPreKeys',
  SESSIONS: 'sessions',
  IDENTITIES: 'identities',
  // Legacy Phase A stores — kept to avoid an IDB structural delete at
  // upgrade (which would block tabs holding open transactions).
  // Stale data sits inert; no read/write paths reference them in B+.
  SENDER_KEYS: 'senderKeys',
  DISTRIBUTED_MEMBERS: 'distributedMembers',
  META: 'meta',
  // Phase B chain stores.
  CHAIN_STATE: 'chainState', // ${kind}:${scopeId}:${senderId}:${senderKeyId} → SerializedChain
  OWN_CHAIN_CURSOR: 'ownChainCursor', // ${kind}:${scopeId}:${senderId} → number (latest own senderKeyId)
  CHAIN_DISTRIBUTION: 'chainDistribution', // ${kind}:${scopeId}:${senderKeyId} → number[] (members SKDM'd)
  DIRTY_CHAINS: 'dirtyChains', // ${kind}:${scopeId} → true (rotate-on-next-encrypt marker)
  // Phase C TOFU store. Keyed by `${userId}` → VerifiedIdentityRecord.
  // Authoritative pinning state for `isTrustedIdentity`. Distinct from
  // IDENTITIES (which mirrors whatever libsignal observed) — this one
  // only changes via deliberate TOFU, manual verify, or accept-change.
  VERIFIED_IDENTITIES: 'verifiedIdentities'
} as const;

const META_KEYS = {
  NEXT_OTP_KEY_ID: 'nextOtpKeyId',
  SIGNED_PRE_KEY_ID: 'signedPreKeyId',
  SIGNED_PRE_KEY_ROTATED_AT: 'signedPreKeyRotatedAt'
} as const;

type SerializedKeyPair = {
  pubKey: string;
  privKey: string;
};

export type VerifiedIdentityMethod = 'tofu' | 'manual';

export type VerifiedIdentityRecord = {
  /** Pinned identity public key, base64-encoded (matches IDENTITIES store format). */
  identityPublicKey: string;
  /** Unix ms when this identity was first pinned (TOFU) or manually verified. */
  verifiedAt: number;
  /** TOFU = silently pinned on first session; manual = user confirmed in-person. */
  verifiedMethod: VerifiedIdentityMethod;
  /** Unix ms of the most recent accept-identity-change event (modal Accept,
   *  Verify Now, or auto-accept on broadcast). When set, the UI surfaces a
   *  "recently changed" warning until the user explicitly re-verifies or
   *  clears the pin. */
  acceptedChangeAt?: number;
};

export type VerifiedIdentityEntry = VerifiedIdentityRecord & { userId: number };

function serializeKeyPair(kp: KeyPairType): SerializedKeyPair {
  return {
    pubKey: arrayBufferToBase64(kp.pubKey),
    privKey: arrayBufferToBase64(kp.privKey)
  };
}

function deserializeKeyPair(skp: SerializedKeyPair): KeyPairType {
  return {
    pubKey: base64ToArrayBuffer(skp.pubKey),
    privKey: base64ToArrayBuffer(skp.privKey)
  };
}

function openStoreDb(dbName: string): Promise<IDBPDatabase> {
  return openDB(dbName, DB_VERSION, {
    upgrade(db) {
      for (const store of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      }
    }
  });
}

export class SignalProtocolStore implements StorageType {
  private dbName: string;
  private dbInstance: IDBPDatabase | null = null;

  constructor(dbName: string = HOME_DB_NAME) {
    this.dbName = dbName;
  }

  private async getDb(): Promise<IDBPDatabase> {
    if (this.dbInstance) return this.dbInstance;
    this.dbInstance = await openStoreDb(this.dbName);
    return this.dbInstance;
  }

  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    const db = await this.getDb();
    const serialized = await db.get(STORES.IDENTITY_KEY, 'identityKey');
    if (!serialized) return undefined;
    return deserializeKeyPair(serialized);
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const db = await this.getDb();
    return db.get(STORES.REGISTRATION_ID, 'registrationId');
  }

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    _direction: Direction
  ): Promise<boolean> {
    // Phase C TOFU. The libsignal address format is `${userId}.${deviceId}`.
    // Anything we can't parse falls back to permissive trust so a
    // malformed address can't break session establishment during an
    // upgrade window. The TOFU path means: first observation pins
    // silently; subsequent observations must match the pinned key.
    const dot = identifier.indexOf('.');
    const userIdStr = dot >= 0 ? identifier.slice(0, dot) : identifier;
    const userId = Number(userIdStr);
    if (!Number.isFinite(userId) || userId <= 0) return true;

    const incomingB64 = arrayBufferToBase64(identityKey);
    const verified = await this.getVerifiedIdentity(userId);

    if (!verified) {
      await this.markIdentityTofu(userId, incomingB64);
      return true;
    }

    // Mismatch causes libsignal to throw, which the caller catches and
    // surfaces via the identity-changed modal (Phase C4).
    return verified.identityPublicKey === incomingB64;
  }

  /** Accept an identity change for `userId`: drop the old pin and
   *  re-TOFU under the new key, AND set the `acceptedChangeAt`
   *  marker so the UI surfaces a sticky "recently changed" warning
   *  until the user explicitly re-verifies (markIdentityManual) or
   *  clears the pin. Used by the user's explicit "Accept" action in
   *  the identity-changed modal, and by the auto-accept path that
   *  handles legitimate peer-broadcast resets. */
  async acceptIdentityChange(
    userId: number,
    newIdentityPublicKey: string
  ): Promise<void> {
    const db = await this.getDb();
    const now = Date.now();
    const record: VerifiedIdentityRecord = {
      identityPublicKey: newIdentityPublicKey,
      verifiedAt: now,
      verifiedMethod: 'tofu',
      acceptedChangeAt: now
    };
    await db.put(STORES.VERIFIED_IDENTITIES, record, String(userId));
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer
  ): Promise<boolean> {
    const db = await this.getDb();
    const existing = await db.get(STORES.IDENTITIES, encodedAddress);
    await db.put(
      STORES.IDENTITIES,
      arrayBufferToBase64(publicKey),
      encodedAddress
    );

    if (existing) {
      const existingKey = base64ToArrayBuffer(existing);
      const existingView = new Uint8Array(existingKey);
      const newView = new Uint8Array(publicKey);

      if (existingView.length !== newView.length) return true;
      for (let i = 0; i < existingView.length; i++) {
        if (existingView[i] !== newView[i]) return true;
      }
      return false; // Same key
    }

    return false; // New identity, not a change
  }

  async loadPreKey(
    encodedAddress: string | number
  ): Promise<KeyPairType | undefined> {
    const db = await this.getDb();
    const serialized = await db.get(
      STORES.PRE_KEYS,
      String(encodedAddress)
    );
    if (!serialized) return undefined;
    return deserializeKeyPair(serialized);
  }

  async storePreKey(
    keyId: number | string,
    keyPair: KeyPairType
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(STORES.PRE_KEYS, serializeKeyPair(keyPair), String(keyId));
  }

  async removePreKey(keyId: number | string): Promise<void> {
    const db = await this.getDb();
    await db.delete(STORES.PRE_KEYS, String(keyId));
  }

  async loadSignedPreKey(
    keyId: number | string
  ): Promise<KeyPairType | undefined> {
    const db = await this.getDb();
    const serialized = await db.get(
      STORES.SIGNED_PRE_KEYS,
      String(keyId)
    );
    if (!serialized) return undefined;
    return deserializeKeyPair(serialized);
  }

  async storeSignedPreKey(
    keyId: number | string,
    keyPair: KeyPairType
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(
      STORES.SIGNED_PRE_KEYS,
      serializeKeyPair(keyPair),
      String(keyId)
    );
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    const db = await this.getDb();
    await db.delete(STORES.SIGNED_PRE_KEYS, String(keyId));
  }

  async loadSession(
    encodedAddress: string
  ): Promise<SessionRecordType | undefined> {
    const db = await this.getDb();
    return db.get(STORES.SESSIONS, encodedAddress);
  }

  async storeSession(
    encodedAddress: string,
    record: SessionRecordType
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(STORES.SESSIONS, record, encodedAddress);
  }

  // Store the identity key pair and registration ID locally
  async saveLocalIdentity(
    keyPair: KeyPairType,
    registrationId: number
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(
      STORES.IDENTITY_KEY,
      serializeKeyPair(keyPair),
      'identityKey'
    );
    await db.put(
      STORES.REGISTRATION_ID,
      registrationId,
      'registrationId'
    );
  }

  async hasLocalIdentity(): Promise<boolean> {
    const db = await this.getDb();
    const kp = await db.get(STORES.IDENTITY_KEY, 'identityKey');
    return !!kp;
  }

  // In-memory sender key cache to avoid repeated IndexedDB reads
  private senderKeyCache = new Map<string, string>();

  // Sender key methods for channel E2EE
  async getSenderKey(
    channelId: number,
    userId: number
  ): Promise<string | undefined> {
    const cacheKey = `${channelId}:${userId}`;
    const cached = this.senderKeyCache.get(cacheKey);
    if (cached) return cached;

    const db = await this.getDb();
    const value = await db.get(STORES.SENDER_KEYS, cacheKey);
    if (value) this.senderKeyCache.set(cacheKey, value);
    return value;
  }

  async storeSenderKey(
    channelId: number,
    userId: number,
    key: string
  ): Promise<void> {
    const cacheKey = `${channelId}:${userId}`;
    this.senderKeyCache.set(cacheKey, key);
    const db = await this.getDb();
    await db.put(STORES.SENDER_KEYS, key, cacheKey);
  }

  // DM-channel sender keys are stored in the same IDB object store but
  // keyed with a `dm:` prefix so they can't collide with server-channel
  // ids (server channel 5 and dm channel 5 are different things).
  async getDmSenderKey(
    dmChannelId: number,
    userId: number
  ): Promise<string | undefined> {
    const cacheKey = `dm:${dmChannelId}:${userId}`;
    const cached = this.senderKeyCache.get(cacheKey);
    if (cached) return cached;

    const db = await this.getDb();
    const value = await db.get(STORES.SENDER_KEYS, cacheKey);
    if (value) this.senderKeyCache.set(cacheKey, value);
    return value;
  }

  async storeDmSenderKey(
    dmChannelId: number,
    userId: number,
    key: string
  ): Promise<void> {
    const cacheKey = `dm:${dmChannelId}:${userId}`;
    this.senderKeyCache.set(cacheKey, key);
    const db = await this.getDb();
    await db.put(STORES.SENDER_KEYS, key, cacheKey);
  }

  async getDmDistributedMembers(dmChannelId: number): Promise<number[]> {
    const db = await this.getDb();
    const value = await db.get(STORES.DISTRIBUTED_MEMBERS, `dm:${dmChannelId}`);
    return value ?? [];
  }

  async setDmDistributedMembers(
    dmChannelId: number,
    memberIds: number[]
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(STORES.DISTRIBUTED_MEMBERS, memberIds, `dm:${dmChannelId}`);
  }

  async getStoredIdentityKey(userId: number): Promise<string | undefined> {
    const db = await this.getDb();
    return db.get(STORES.IDENTITIES, `${userId}.1`);
  }

  async clearUserSession(userId: number): Promise<void> {
    const db = await this.getDb();
    const address = `${userId}.1`;
    await db.delete(STORES.SESSIONS, address);
    await db.delete(STORES.IDENTITIES, address);
  }

  async copyIdentityFrom(source: SignalProtocolStore): Promise<void> {
    const keyPair = await source.getIdentityKeyPair();
    const registrationId = await source.getLocalRegistrationId();
    if (!keyPair || registrationId === undefined) {
      throw new Error('Source store has no identity to copy');
    }
    await this.saveLocalIdentity(keyPair, registrationId);
  }

  // --- Distributed Members persistence ---

  async getDistributedMembers(channelId: number): Promise<number[]> {
    const db = await this.getDb();
    const value = await db.get(
      STORES.DISTRIBUTED_MEMBERS,
      String(channelId)
    );
    return value ?? [];
  }

  async setDistributedMembers(
    channelId: number,
    memberIds: number[]
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(
      STORES.DISTRIBUTED_MEMBERS,
      memberIds,
      String(channelId)
    );
  }

  async clearDistributedMemberFromAll(userId: number): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORES.DISTRIBUTED_MEMBERS, 'readwrite');
    const store = tx.objectStore(STORES.DISTRIBUTED_MEMBERS);
    let cursor = await store.openCursor();
    while (cursor) {
      const members: number[] = cursor.value;
      const filtered = members.filter((id) => id !== userId);
      if (filtered.length !== members.length) {
        await cursor.update(filtered);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  async clearAllDistributedMembers(): Promise<void> {
    const db = await this.getDb();
    await db.clear(STORES.DISTRIBUTED_MEMBERS);
  }

  async clearAll(): Promise<void> {
    this.senderKeyCache.clear();
    const db = await this.getDb();
    const tx = db.transaction(Object.values(STORES), 'readwrite');
    for (const store of Object.values(STORES)) {
      tx.objectStore(store).clear();
    }
    await tx.done;
  }

  /**
   * Wipe every Signal session in IDB. Used after a key restore: the
   * restored sessions describe a ratchet state that no peer agrees with
   * anymore (peers rebuilt theirs in response to the regen broadcast that
   * the restore is undoing). Forcing rebuild via X3DH on next encrypt is
   * the only way to get back in sync.
   */
  async clearAllSessions(): Promise<void> {
    const db = await this.getDb();
    await db.clear(STORES.SESSIONS);
  }

  /**
   * Wipe every Phase B sender-key chain in IDB. Used after a key
   * restore for the same reason as clearAllSessions: chains held by
   * peers describe a ratchet state we no longer agree with after the
   * restore, so we have to drop everything and let SKDMs rebuild on
   * next interaction.
   */
  async clearAllChains(): Promise<void> {
    const db = await this.getDb();
    await Promise.all([
      db.clear(STORES.CHAIN_STATE),
      db.clear(STORES.OWN_CHAIN_CURSOR),
      db.clear(STORES.CHAIN_DISTRIBUTION),
      db.clear(STORES.DIRTY_CHAINS)
    ]);
  }

  // --- Phase B chain state ---

  /** Compose the IDB key for a specific chain. */
  private chainKey(
    kind: ChainKind,
    scopeId: number,
    senderId: number,
    senderKeyId: number
  ): string {
    return `${kind}:${scopeId}:${senderId}:${senderKeyId}`;
  }

  async getChain(
    kind: ChainKind,
    scopeId: number,
    senderId: number,
    senderKeyId: number
  ): Promise<SerializedChain | undefined> {
    const db = await this.getDb();
    return db.get(
      STORES.CHAIN_STATE,
      this.chainKey(kind, scopeId, senderId, senderKeyId)
    );
  }

  async storeChain(
    kind: ChainKind,
    scopeId: number,
    senderId: number,
    senderKeyId: number,
    chain: SerializedChain
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(
      STORES.CHAIN_STATE,
      chain,
      this.chainKey(kind, scopeId, senderId, senderKeyId)
    );
  }

  /** Latest senderKeyId we've issued for our own outbound chain on
   *  (kind, scopeId, ownUserId). Returns undefined when no outbound
   *  chain has ever been generated for this scope. */
  async getOwnSenderKeyId(
    kind: ChainKind,
    scopeId: number,
    ownUserId: number
  ): Promise<number | undefined> {
    const db = await this.getDb();
    const v = await db.get(
      STORES.OWN_CHAIN_CURSOR,
      `${kind}:${scopeId}:${ownUserId}`
    );
    return typeof v === 'number' ? v : undefined;
  }

  async setOwnSenderKeyId(
    kind: ChainKind,
    scopeId: number,
    ownUserId: number,
    senderKeyId: number
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(
      STORES.OWN_CHAIN_CURSOR,
      senderKeyId,
      `${kind}:${scopeId}:${ownUserId}`
    );
  }

  async getChainDistribution(
    kind: ChainKind,
    scopeId: number,
    senderKeyId: number
  ): Promise<number[]> {
    const db = await this.getDb();
    const v = await db.get(
      STORES.CHAIN_DISTRIBUTION,
      `${kind}:${scopeId}:${senderKeyId}`
    );
    return v ?? [];
  }

  async setChainDistribution(
    kind: ChainKind,
    scopeId: number,
    senderKeyId: number,
    memberIds: number[]
  ): Promise<void> {
    const db = await this.getDb();
    await db.put(
      STORES.CHAIN_DISTRIBUTION,
      memberIds,
      `${kind}:${scopeId}:${senderKeyId}`
    );
  }

  /** Drop one user from every chainDistribution row. Used when a peer
   *  resets their identity — we need to redistribute every active
   *  chain to them again so they can decrypt under their new keys. */
  async clearChainDistributionForUser(userId: number): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORES.CHAIN_DISTRIBUTION, 'readwrite');
    const store = tx.objectStore(STORES.CHAIN_DISTRIBUTION);
    let cursor = await store.openCursor();
    while (cursor) {
      const members: number[] = cursor.value;
      const filtered = members.filter((id) => id !== userId);
      if (filtered.length !== members.length) {
        await cursor.update(filtered);
      }
      cursor = await cursor.continue();
    }
    await tx.done;
  }

  /** Mark a (kind, scopeId) as needing rotation on the owner's next
   *  encrypt. Set when a member is kicked/leaves so we can lazily
   *  bump senderKeyId without a synchronous N-way fan-out. */
  async markChainDirty(kind: ChainKind, scopeId: number): Promise<void> {
    const db = await this.getDb();
    await db.put(STORES.DIRTY_CHAINS, true, `${kind}:${scopeId}`);
  }

  async isChainDirty(kind: ChainKind, scopeId: number): Promise<boolean> {
    const db = await this.getDb();
    const v = await db.get(STORES.DIRTY_CHAINS, `${kind}:${scopeId}`);
    return v === true;
  }

  async clearChainDirty(kind: ChainKind, scopeId: number): Promise<void> {
    const db = await this.getDb();
    await db.delete(STORES.DIRTY_CHAINS, `${kind}:${scopeId}`);
  }

  // --- Phase C TOFU / safety-number pinning ---

  async getVerifiedIdentity(
    userId: number
  ): Promise<VerifiedIdentityRecord | undefined> {
    const db = await this.getDb();
    const v = await db.get(STORES.VERIFIED_IDENTITIES, String(userId));
    return v as VerifiedIdentityRecord | undefined;
  }

  /** Pin a peer's identity key under TOFU. First time we observe this
   *  peer's identity, we record it silently — no UI prompt. Subsequent
   *  identity changes will fail `isTrustedIdentity` until the user
   *  explicitly accepts via `acceptIdentityChange`. */
  async markIdentityTofu(
    userId: number,
    identityPublicKey: string
  ): Promise<void> {
    const db = await this.getDb();
    const record: VerifiedIdentityRecord = {
      identityPublicKey,
      verifiedAt: Date.now(),
      verifiedMethod: 'tofu'
    };
    await db.put(STORES.VERIFIED_IDENTITIES, record, String(userId));
  }

  /** Mark a peer's identity as manually verified (e.g., the user
   *  compared the safety number in person). Clears any
   *  acceptedChangeAt warning since manual verify is the strongest
   *  trust signal. */
  async markIdentityManual(
    userId: number,
    identityPublicKey: string
  ): Promise<void> {
    const db = await this.getDb();
    const record: VerifiedIdentityRecord = {
      identityPublicKey,
      verifiedAt: Date.now(),
      verifiedMethod: 'manual'
    };
    await db.put(STORES.VERIFIED_IDENTITIES, record, String(userId));
  }

  async clearVerifiedIdentity(userId: number): Promise<void> {
    const db = await this.getDb();
    await db.delete(STORES.VERIFIED_IDENTITIES, String(userId));
  }

  /** All pinned identities in this store. Used by the Verify Identity
   *  settings page to render the per-peer status list. */
  async listVerifiedIdentities(): Promise<VerifiedIdentityEntry[]> {
    const db = await this.getDb();
    const tx = db.transaction(STORES.VERIFIED_IDENTITIES, 'readonly');
    const store = tx.objectStore(STORES.VERIFIED_IDENTITIES);
    const keys = await store.getAllKeys();
    const values = (await store.getAll()) as VerifiedIdentityRecord[];
    await tx.done;
    return keys.map((key, i) => ({
      userId: Number(key),
      ...values[i]
    }));
  }

  // --- META: per-store counters that must survive page reloads ---

  async getNextOtpKeyId(): Promise<number | undefined> {
    const db = await this.getDb();
    const v = await db.get(STORES.META, META_KEYS.NEXT_OTP_KEY_ID);
    return typeof v === 'number' ? v : undefined;
  }

  async setNextOtpKeyId(id: number): Promise<void> {
    const db = await this.getDb();
    await db.put(STORES.META, id, META_KEYS.NEXT_OTP_KEY_ID);
  }

  async getSignedPreKeyId(): Promise<number | undefined> {
    const db = await this.getDb();
    const v = await db.get(STORES.META, META_KEYS.SIGNED_PRE_KEY_ID);
    return typeof v === 'number' ? v : undefined;
  }

  async setSignedPreKeyId(id: number): Promise<void> {
    const db = await this.getDb();
    await db.put(STORES.META, id, META_KEYS.SIGNED_PRE_KEY_ID);
  }

  async getSignedPreKeyRotatedAt(): Promise<number | undefined> {
    const db = await this.getDb();
    const v = await db.get(STORES.META, META_KEYS.SIGNED_PRE_KEY_ROTATED_AT);
    return typeof v === 'number' ? v : undefined;
  }

  async setSignedPreKeyRotatedAt(ts: number): Promise<void> {
    const db = await this.getDb();
    await db.put(STORES.META, ts, META_KEYS.SIGNED_PRE_KEY_ROTATED_AT);
  }
}

// Home instance store (singleton, backward compatible)
export const signalStore = new SignalProtocolStore();

// Cache of per-instance stores keyed by domain
const instanceStores = new Map<string, SignalProtocolStore>();

/**
 * Get or create a SignalProtocolStore scoped to a specific federated instance.
 * The home instance (domain = undefined/null) returns `signalStore`.
 */
export function getStoreForInstance(domain: string | null): SignalProtocolStore {
  if (!domain) return signalStore;

  let store = instanceStores.get(domain);
  if (!store) {
    store = new SignalProtocolStore(`pulse-e2ee-${domain}`);
    instanceStores.set(domain, store);
  }
  return store;
}

/**
 * Get the SignalProtocolStore for the currently active instance.
 * Reads `activeInstanceDomain` from Redux state.
 * Returns the home store when no federation context is active.
 */
export function getActiveStore(): SignalProtocolStore {
  const domain = reduxStore.getState().app.activeInstanceDomain as string | null;
  return getStoreForInstance(domain);
}

/**
 * Wipe IDB for the home store and every federated-instance store
 * created in this session. Used on sign-out so the next user on the
 * same browser cannot inherit the previous user's identity, sessions,
 * or sender keys. Also clears the Phase B own-message plaintext
 * cache (which lives in its own IDB).
 */
export async function clearAllStores(): Promise<void> {
  await signalStore.clearAll();
  for (const store of instanceStores.values()) {
    try {
      await store.clearAll();
    } catch {
      // best-effort — keep going so a single failed instance doesn't
      // leave the rest of the IDB residue around
    }
  }
  instanceStores.clear();
  await clearAllOwnPlaintexts();
}
