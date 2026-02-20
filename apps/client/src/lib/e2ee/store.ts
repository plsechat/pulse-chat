import { openDB, type IDBPDatabase } from 'idb';
import type {
  Direction,
  KeyPairType,
  SessionRecordType,
  StorageType
} from '@privacyresearch/libsignal-protocol-typescript';
import { store as reduxStore } from '@/features/store';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

const HOME_DB_NAME = 'pulse-e2ee';
const DB_VERSION = 3;

const STORES = {
  IDENTITY_KEY: 'identityKey',
  REGISTRATION_ID: 'registrationId',
  PRE_KEYS: 'preKeys',
  SIGNED_PRE_KEYS: 'signedPreKeys',
  SESSIONS: 'sessions',
  IDENTITIES: 'identities',
  SENDER_KEYS: 'senderKeys',
  DISTRIBUTED_MEMBERS: 'distributedMembers'
} as const;

type SerializedKeyPair = {
  pubKey: string;
  privKey: string;
};

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
    _identifier: string,
    _identityKey: ArrayBuffer,
    _direction: Direction
  ): Promise<boolean> {
    // Always trust — accept new and changed identities.
    // saveIdentity() will store/update the key, and the Signal library
    // handles session renegotiation via PreKeyWhisperMessages.
    return true;
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
