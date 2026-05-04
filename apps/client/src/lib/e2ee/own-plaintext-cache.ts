/**
 * Plaintext cache for sender-key encrypted messages — both own
 * outbound (captured at encrypt time) and inbound (persisted after a
 * successful chain decrypt).
 *
 * Phase B's SenderKeyChain is forward-secret: the chain advances on
 * every encrypt and decrypt, so a previously-decrypted message can't
 * be decrypted again later. Without this cache, every history
 * re-fetch (page reload, navigation back, etc.) would re-throw
 * `replay or expired skip` for messages whose chain state has moved
 * past their iteration.
 *
 * Two-tier:
 *   - In-memory `Map<ciphertext, plaintext>` populated by encrypt;
 *     enables the subscription echo to self-decrypt without round-
 *     tripping IDB. Bounded LRU at 1000 entries.
 *   - IDB `Map<messageId, plaintext>` populated by both encrypt
 *     (after the consumer learns messageId from the server response)
 *     and by the decrypt path (on every successful chain decrypt).
 *     Reload-survival; key is the server-assigned messageId.
 *
 * Pairwise DM 1:1 messages have their own cache in
 * `features/dms/plaintext-cache.ts` — that one's keyed by messageId
 * via the ratchet-consume model. This module is for sender-key
 * scoped (channel + group DM) plaintexts.
 */

import { openDB, type IDBPDatabase } from 'idb';

const DB_NAME = 'pulse-own-sk-plaintext';
const DB_VERSION = 1;
const STORE_NAME = 'plaintexts';

const MAX_IN_MEMORY = 1000;

const inMemoryByCiphertext = new Map<string, string>();

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
 * Record the plaintext we just encrypted, keyed by the wire bytes
 * we'll see come back via subscription echo. Bounded LRU — older
 * entries are evicted past `MAX_IN_MEMORY` to keep memory flat under
 * a chatty channel.
 */
export function captureOwnPlaintextByCiphertext(
  ciphertext: string,
  plaintext: string
): void {
  if (inMemoryByCiphertext.size >= MAX_IN_MEMORY) {
    const oldest = inMemoryByCiphertext.keys().next().value;
    if (oldest !== undefined) inMemoryByCiphertext.delete(oldest);
  }
  inMemoryByCiphertext.set(ciphertext, plaintext);
}

export function takeOwnPlaintextByCiphertext(
  ciphertext: string
): string | undefined {
  return inMemoryByCiphertext.get(ciphertext);
}

/**
 * Persist the plaintext for `messageId` so a reload can still render
 * own messages from this session. Idempotent overwrite.
 */
export async function persistOwnPlaintextById(
  messageId: number,
  plaintext: string
): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, plaintext, String(messageId));
}

export async function getPersistedOwnPlaintextById(
  messageId: number
): Promise<string | undefined> {
  const db = await getDb();
  return db.get(STORE_NAME, String(messageId));
}

export async function getPersistedOwnPlaintextBatch(
  messageIds: number[]
): Promise<Map<number, string>> {
  if (messageIds.length === 0) return new Map();
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const result = new Map<number, string>();
  await Promise.all(
    messageIds.map(async (id) => {
      const v = await tx.store.get(String(id));
      if (typeof v === 'string') result.set(id, v);
    })
  );
  await tx.done;
  return result;
}

/**
 * Delete the persisted entry — used after an own message is edited so
 * the cache doesn't return stale plaintext for the new ciphertext.
 */
export async function deletePersistedOwnPlaintext(
  messageId: number
): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, String(messageId));
}

/**
 * Wipe everything. Hooked into `clearAllStores` (logout) and
 * `finalizeRestoredKeys` (key restore) so own-message cache doesn't
 * outlive the identity that produced it.
 */
export async function clearAllOwnPlaintexts(): Promise<void> {
  inMemoryByCiphertext.clear();
  try {
    const db = await getDb();
    await db.clear(STORE_NAME);
  } catch {
    // best-effort
  }
}
