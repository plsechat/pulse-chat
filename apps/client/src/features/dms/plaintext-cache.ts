import { openDB, type IDBPDatabase } from 'idb';
import type { E2EEPlaintext } from '@/lib/e2ee/types';

const DB_NAME = 'pulse-dm-plaintext';
const DB_VERSION = 2;
const STORE_NAME = 'plaintexts';

/**
 * Persisted shape: the decrypted plaintext + the ciphertext it came from.
 * The ciphertext lets `decryptDmMessageInPlace` detect when a message has
 * been edited (server replaces content with a new ciphertext under the same
 * id) so we don't keep returning the stale plaintext from cache. Edits go
 * through libsignal as a fresh ratchet step, so the post-edit ciphertext
 * IS replayable as long as we drop the stale cache entry first.
 *
 * Legacy v2 entries (no ciphertext field) still load successfully and are
 * treated as cache hits unconditionally — there's no on-disk migration
 * since the ratchet keys for those messages are already consumed and we
 * can't re-derive the ciphertext anyway.
 */
export type CachedDmPlaintext = E2EEPlaintext & {
  ciphertext?: string;
};

let dbInstance: IDBPDatabase | null = null;

async function getDb(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;
  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        db.createObjectStore(STORE_NAME);
      } else if (oldVersion < 2) {
        // v1 stored plain strings, v2 stores E2EEPlaintext objects.
        // Clear old data — the ratchet keys are already consumed so old
        // ciphertexts can't be re-decrypted regardless.
        db.deleteObjectStore(STORE_NAME);
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
 *
 * Stores the full E2EEPlaintext (content + optional fileKeys) so that
 * encrypted file keys also survive page refreshes.
 */
export async function getCachedPlaintext(
  messageId: number
): Promise<CachedDmPlaintext | undefined> {
  const db = await getDb();
  return db.get(STORE_NAME, String(messageId));
}

export async function setCachedPlaintext(
  messageId: number,
  plaintext: CachedDmPlaintext
): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, plaintext, String(messageId));
}

export async function deleteCachedPlaintext(messageId: number): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, String(messageId));
}

export async function getCachedPlaintextBatch(
  messageIds: number[]
): Promise<Map<number, CachedDmPlaintext>> {
  if (messageIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const results = new Map<number, CachedDmPlaintext>();
  const gets = messageIds.map(async (id) => {
    const val = await tx.store.get(String(id));
    if (val !== undefined) results.set(id, val);
  });
  await Promise.all(gets);
  await tx.done;
  return results;
}

export async function setCachedPlaintextBatch(
  entries: { messageId: number; plaintext: CachedDmPlaintext }[]
): Promise<void> {
  if (entries.length === 0) return;
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  for (const { messageId, plaintext } of entries) {
    tx.store.put(plaintext, String(messageId));
  }
  await tx.done;
}
