import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'pulse-dm-plaintext';
const DB_VERSION = 1;
const STORE_NAME = 'plaintexts';

let dbInstance: IDBPDatabase | null = null;

async function getDb(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;
  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    }
  });
  return dbInstance;
}

/**
 * Persistent plaintext cache for decrypted DM messages.
 * Keyed by message ID so that decrypted content survives page refreshes.
 * Signal Protocol's Double Ratchet consumes message keys on decryption,
 * so ciphertexts can only be decrypted once — this cache stores the result.
 */
export async function getCachedPlaintext(
  messageId: number
): Promise<string | undefined> {
  const db = await getDb();
  return db.get(STORE_NAME, String(messageId));
}

export async function setCachedPlaintext(
  messageId: number,
  content: string
): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, content, String(messageId));
}

export async function setCachedPlaintextBatch(
  entries: { messageId: number; content: string }[]
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  for (const { messageId, content } of entries) {
    tx.store.put(content, String(messageId));
  }
  await tx.done;
}
