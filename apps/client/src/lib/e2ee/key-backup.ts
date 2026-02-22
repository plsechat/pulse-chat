import { openDB } from 'idb';
import { arrayBufferToBase64, base64ToArrayBuffer } from './utils';

const HOME_DB_NAME = 'pulse-e2ee';
const DB_VERSION = 3;

const STORE_NAMES = [
  'identityKey',
  'registrationId',
  'preKeys',
  'signedPreKeys',
  'sessions',
  'identities',
  'senderKeys'
] as const;

// V1 stores (before senderKeys was added)
const V1_STORE_NAMES = [
  'identityKey',
  'registrationId',
  'preKeys',
  'signedPreKeys',
  'sessions',
  'identities'
] as const;

export const PBKDF2_ITERATIONS = 600_000;

export const BACKUP_STORE_NAMES = STORE_NAMES;

export type BackupPayload = {
  version: 1 | 2;
  salt: string;
  iv: string;
  ciphertext: string;
};

function getDbName(domain?: string): string {
  return domain ? `pulse-e2ee-${domain}` : HOME_DB_NAME;
}

export async function deriveBackupKey(
  passphrase: string,
  salt: Uint8Array
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptBackupData(
  data: Record<string, unknown[]>,
  passphrase: string
): Promise<BackupPayload> {
  const json = JSON.stringify(data);
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(json);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext
  );

  return {
    version: 2,
    salt: arrayBufferToBase64(salt.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    ciphertext: arrayBufferToBase64(ciphertext)
  };
}

export async function decryptBackupPayload(
  payload: BackupPayload,
  passphrase: string
): Promise<Record<string, unknown[]>> {
  if (payload.version !== 1 && payload.version !== 2) {
    throw new Error(`Unsupported backup version: ${payload.version}`);
  }

  if (!payload.salt || !payload.iv || !payload.ciphertext) {
    throw new Error('Backup file is missing required fields');
  }

  const salt = new Uint8Array(base64ToArrayBuffer(payload.salt));
  const iv = new Uint8Array(base64ToArrayBuffer(payload.iv));
  const ciphertext = base64ToArrayBuffer(payload.ciphertext);
  const key = await deriveBackupKey(passphrase, salt);

  let decrypted: ArrayBuffer;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  } catch {
    throw new Error('Wrong passphrase or corrupted backup file');
  }

  const decoder = new TextDecoder();
  const json = decoder.decode(decrypted);
  let data: Record<string, unknown[]>;

  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('Decrypted data is not valid JSON');
  }

  // Validate stores — v1 backups won't have senderKeys, which is fine
  const requiredStores =
    payload.version === 1 ? V1_STORE_NAMES : STORE_NAMES;
  for (const storeName of requiredStores) {
    if (!Array.isArray(data[storeName])) {
      throw new Error(`Backup is missing store: ${storeName}`);
    }
  }

  return data;
}

async function readAllStores(
  dbName: string
): Promise<Record<string, unknown[]>> {
  const db = await openDB(dbName, DB_VERSION, {
    upgrade(db) {
      for (const storeName of STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      }
    }
  });
  const data: Record<string, unknown[]> = {};

  for (const storeName of STORE_NAMES) {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const keys = await store.getAllKeys();
    const values = await store.getAll();
    await tx.done;

    data[storeName] = keys.map((key, i) => ({ key, value: values[i] }));
  }

  db.close();
  return data;
}

async function writeAllStores(
  dbName: string,
  data: Record<string, { key: IDBValidKey; value: unknown }[]>
): Promise<void> {
  const db = await openDB(dbName, DB_VERSION, {
    upgrade(db) {
      for (const storeName of STORE_NAMES) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      }
    }
  });

  // Clear all stores and write new data in one transaction
  const tx = db.transaction([...STORE_NAMES], 'readwrite');

  for (const storeName of STORE_NAMES) {
    const store = tx.objectStore(storeName);
    await store.clear();

    const entries = data[storeName] ?? [];
    for (const entry of entries) {
      await store.put(entry.value, entry.key);
    }
  }

  await tx.done;
  db.close();
}

export async function exportKeys(
  passphrase: string,
  domain?: string
): Promise<Blob> {
  const dbName = getDbName(domain);
  const storeData = await readAllStores(dbName);
  const payload = await encryptBackupData(storeData, passphrase);
  return new Blob([JSON.stringify(payload)], { type: 'application/json' });
}

export async function importKeys(
  file: File,
  passphrase: string,
  domain?: string
): Promise<void> {
  const dbName = getDbName(domain);
  const text = await file.text();
  let payload: BackupPayload;

  try {
    payload = JSON.parse(text) as BackupPayload;
  } catch {
    throw new Error('Invalid backup file format');
  }

  const data = await decryptBackupPayload(payload, passphrase);
  await writeAllStores(
    dbName,
    data as Record<string, { key: IDBValidKey; value: unknown }[]>
  );
}

/**
 * Upload an encrypted key backup to the server.
 * Reads all IDB stores, encrypts with the given passphrase,
 * and sends the encrypted blob to the server.
 */
export async function uploadBackupToServer(
  passphrase: string,
  domain?: string
): Promise<void> {
  const { getHomeTRPCClient } = await import('@/lib/trpc');
  const dbName = getDbName(domain);
  const storeData = await readAllStores(dbName);
  const payload = await encryptBackupData(storeData, passphrase);
  const trpc = getHomeTRPCClient();
  await trpc.e2ee.uploadKeyBackup.mutate({
    encryptedData: JSON.stringify(payload)
  });
}

/**
 * Restore keys from a server-side backup.
 * Downloads the encrypted blob, decrypts with passphrase, writes to IDB.
 */
export async function restoreBackupFromServer(
  passphrase: string,
  domain?: string
): Promise<void> {
  const { getHomeTRPCClient } = await import('@/lib/trpc');
  const trpc = getHomeTRPCClient();
  const backup = await trpc.e2ee.getKeyBackup.query();

  if (!backup) {
    throw new Error('No server backup found');
  }

  let payload: BackupPayload;
  try {
    payload = JSON.parse(backup.encryptedData) as BackupPayload;
  } catch {
    throw new Error('Server backup data is corrupted');
  }

  const data = await decryptBackupPayload(payload, passphrase);
  const dbName = getDbName(domain);
  await writeAllStores(
    dbName,
    data as Record<string, { key: IDBValidKey; value: unknown }[]>
  );
}
