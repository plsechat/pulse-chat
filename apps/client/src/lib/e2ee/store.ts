import { openDB, type IDBPDatabase } from 'idb';
import type {
  Direction,
  KeyPairType,
  SessionRecordType,
  StorageType
} from '@privacyresearch/libsignal-protocol-typescript';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

const DB_NAME = 'pulse-e2ee';
const DB_VERSION = 2;

const STORES = {
  IDENTITY_KEY: 'identityKey',
  REGISTRATION_ID: 'registrationId',
  PRE_KEYS: 'preKeys',
  SIGNED_PRE_KEYS: 'signedPreKeys',
  SESSIONS: 'sessions',
  IDENTITIES: 'identities',
  SENDER_KEYS: 'senderKeys'
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

let dbInstance: IDBPDatabase | null = null;

async function getDb(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORES.IDENTITY_KEY)) {
        db.createObjectStore(STORES.IDENTITY_KEY);
      }
      if (!db.objectStoreNames.contains(STORES.REGISTRATION_ID)) {
        db.createObjectStore(STORES.REGISTRATION_ID);
      }
      if (!db.objectStoreNames.contains(STORES.PRE_KEYS)) {
        db.createObjectStore(STORES.PRE_KEYS);
      }
      if (!db.objectStoreNames.contains(STORES.SIGNED_PRE_KEYS)) {
        db.createObjectStore(STORES.SIGNED_PRE_KEYS);
      }
      if (!db.objectStoreNames.contains(STORES.SESSIONS)) {
        db.createObjectStore(STORES.SESSIONS);
      }
      if (!db.objectStoreNames.contains(STORES.IDENTITIES)) {
        db.createObjectStore(STORES.IDENTITIES);
      }
      if (!db.objectStoreNames.contains(STORES.SENDER_KEYS)) {
        db.createObjectStore(STORES.SENDER_KEYS);
      }
    }
  });

  return dbInstance;
}

export class SignalProtocolStore implements StorageType {
  async getIdentityKeyPair(): Promise<KeyPairType | undefined> {
    const db = await getDb();
    const serialized = await db.get(STORES.IDENTITY_KEY, 'identityKey');
    if (!serialized) return undefined;
    return deserializeKeyPair(serialized);
  }

  async getLocalRegistrationId(): Promise<number | undefined> {
    const db = await getDb();
    return db.get(STORES.REGISTRATION_ID, 'registrationId');
  }

  async isTrustedIdentity(
    _identifier: string,
    _identityKey: ArrayBuffer,
    _direction: Direction
  ): Promise<boolean> {
    // Trust on first use (TOFU)
    // In a production app, you'd compare against stored identity
    const db = await getDb();
    const existing = await db.get(STORES.IDENTITIES, _identifier);

    if (!existing) {
      return true; // First time seeing this identity
    }

    // Compare the stored identity key with the provided one
    const existingKey = base64ToArrayBuffer(existing);
    const existingView = new Uint8Array(existingKey);
    const newView = new Uint8Array(_identityKey);

    if (existingView.length !== newView.length) return false;
    for (let i = 0; i < existingView.length; i++) {
      if (existingView[i] !== newView[i]) return false;
    }
    return true;
  }

  async saveIdentity(
    encodedAddress: string,
    publicKey: ArrayBuffer
  ): Promise<boolean> {
    const db = await getDb();
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
    const db = await getDb();
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
    const db = await getDb();
    await db.put(STORES.PRE_KEYS, serializeKeyPair(keyPair), String(keyId));
  }

  async removePreKey(keyId: number | string): Promise<void> {
    const db = await getDb();
    await db.delete(STORES.PRE_KEYS, String(keyId));
  }

  async loadSignedPreKey(
    keyId: number | string
  ): Promise<KeyPairType | undefined> {
    const db = await getDb();
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
    const db = await getDb();
    await db.put(
      STORES.SIGNED_PRE_KEYS,
      serializeKeyPair(keyPair),
      String(keyId)
    );
  }

  async removeSignedPreKey(keyId: number | string): Promise<void> {
    const db = await getDb();
    await db.delete(STORES.SIGNED_PRE_KEYS, String(keyId));
  }

  async loadSession(
    encodedAddress: string
  ): Promise<SessionRecordType | undefined> {
    const db = await getDb();
    return db.get(STORES.SESSIONS, encodedAddress);
  }

  async storeSession(
    encodedAddress: string,
    record: SessionRecordType
  ): Promise<void> {
    const db = await getDb();
    await db.put(STORES.SESSIONS, record, encodedAddress);
  }

  // Store the identity key pair and registration ID locally
  async saveLocalIdentity(
    keyPair: KeyPairType,
    registrationId: number
  ): Promise<void> {
    const db = await getDb();
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
    const db = await getDb();
    const kp = await db.get(STORES.IDENTITY_KEY, 'identityKey');
    return !!kp;
  }

  // Sender key methods for channel E2EE
  async getSenderKey(
    channelId: number,
    userId: number
  ): Promise<string | undefined> {
    const db = await getDb();
    return db.get(STORES.SENDER_KEYS, `${channelId}:${userId}`);
  }

  async storeSenderKey(
    channelId: number,
    userId: number,
    key: string
  ): Promise<void> {
    const db = await getDb();
    await db.put(STORES.SENDER_KEYS, key, `${channelId}:${userId}`);
  }

  async clearAll(): Promise<void> {
    const db = await getDb();
    const tx = db.transaction(Object.values(STORES), 'readwrite');
    for (const store of Object.values(STORES)) {
      tx.objectStore(store).clear();
    }
    await tx.done;
  }
}

export const signalStore = new SignalProtocolStore();
