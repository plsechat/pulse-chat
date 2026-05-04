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

// IDB name retained from before the file rename so existing user
// caches survive the upgrade. The database is single-purpose; no
// reason to break compatibility for cosmetic naming.
const DB_NAME = 'pulse-own-sk-plaintext';
const DB_VERSION = 1;
const STORE_NAME = 'plaintexts';

const MAX_IN_MEMORY = 1000;

// Bounded IDB cache. Keys are server-assigned messageIds, which are
// monotonically increasing — when we exceed `MAX_IDB_ENTRIES` we
// sort numerically and delete the smallest (oldest message ids)
// down to `TARGET_IDB_ENTRIES`. Compaction runs lazily: once at
// startup if needed, and again after every `WRITES_PER_COMPACTION`
// writes within a session. Active conversations therefore see
// bounded memory without the hot-path paying for it.
const MAX_IDB_ENTRIES = 10_000;
const TARGET_IDB_ENTRIES = 8_000;
const WRITES_PER_COMPACTION = 500;

const inMemoryByCiphertext = new Map<string, string>();

let dbInstance: IDBPDatabase | null = null;
let writesSinceLastCompact = 0;
let compactionInFlight: Promise<void> | null = null;

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
 *
 * Triggers lazy compaction every WRITES_PER_COMPACTION writes so the
 * IDB store can't grow unboundedly across long-lived sessions.
 */
export async function persistOwnPlaintextById(
  messageId: number,
  plaintext: string
): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, plaintext, String(messageId));

  writesSinceLastCompact++;
  if (writesSinceLastCompact >= WRITES_PER_COMPACTION) {
    writesSinceLastCompact = 0;
    void scheduleCompaction();
  }
}

/**
 * If the persisted store is over the soft cap, prune the smallest
 * (oldest, since messageId is monotonically increasing) entries down
 * to TARGET_IDB_ENTRIES. Single-flight: a second call while one is
 * already running just awaits the in-flight promise.
 */
async function scheduleCompaction(): Promise<void> {
  if (compactionInFlight) return compactionInFlight;
  compactionInFlight = (async () => {
    try {
      const db = await getDb();
      const count = await db.count(STORE_NAME);
      if (count <= MAX_IDB_ENTRIES) return;

      const keys = (await db.getAllKeys(STORE_NAME)) as string[];
      // String-keyed by messageId.toString(); sort numerically so we
      // drop the genuinely-oldest rows rather than lexicographically.
      keys.sort((a, b) => Number(a) - Number(b));

      const toDelete = keys.slice(0, count - TARGET_IDB_ENTRIES);
      const tx = db.transaction(STORE_NAME, 'readwrite');
      await Promise.all(toDelete.map((k) => tx.store.delete(k)));
      await tx.done;
    } catch (err) {
      console.warn('[plaintext-cache] compaction failed:', err);
    } finally {
      compactionInFlight = null;
    }
  })();
  return compactionInFlight;
}

// Boot-time compaction so a previous session's growth doesn't carry
// uncompacted into a new one. Best-effort; any failure here just
// means we'll try again at the next write threshold.
void scheduleCompaction();

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
