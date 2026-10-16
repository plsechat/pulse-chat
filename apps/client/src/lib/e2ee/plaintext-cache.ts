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
 *   - IDB keyed by `<instance>:<kind>:<messageId>`, populated by both
 *     encrypt (after the consumer learns messageId from the server
 *     response) and by the decrypt path (on every successful chain
 *     decrypt). Reload-survival.
 *
 * Why the key carries instance + kind: `messages.id` and
 * `dm_messages.id` are independent serials, and every federated host
 * has its own `messages` serial too, so channel message 7, group-DM
 * message 7 and host-X message 7 are three different conversations.
 * A bare-id key made them share one slot and the lookup — which runs
 * before any chain work — short-circuited with another
 * conversation's text.
 *
 * Why the entry carries the ciphertext: an edit replaces the content
 * under the SAME id. The author re-encrypts, so the new wire is a
 * fresh chain iteration the recipient can decrypt — but only if the
 * lookup refuses the stale entry. A hit therefore requires
 * `entry.ciphertext === wire`; anything else is dropped and the
 * caller falls through to the chain.
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
// v2: scoped keys + ciphertext-bound entries. The v1 rows (bare
// numeric key, bare plaintext string) are left in place rather than
// wiped: they are unattributable across conversations, but for the
// user's OWN messages the worst case of a wrong hit is showing the
// user their own text from another conversation, while wiping would
// lose every own message sent before the upgrade (the chain cannot
// re-derive them). So v1 rows stay readable through a read-only
// fallback that callers enable only for own messages; nothing ever
// writes a v1-shaped row again and compaction prunes them with the
// rest.
const DB_VERSION = 2;
const STORE_NAME = 'plaintexts';

const MAX_IN_MEMORY = 1000;

// Bounded IDB cache. The numeric suffix of every key is a server-
// assigned messageId, monotonically increasing within its id space —
// when we exceed `MAX_IDB_ENTRIES` we sort by that suffix and delete
// the smallest (oldest message ids) down to `TARGET_IDB_ENTRIES`.
// Compaction runs lazily: once at startup if needed, and again after
// every `WRITES_PER_COMPACTION` writes within a session. Active
// conversations therefore see bounded memory without the hot-path
// paying for it.
const MAX_IDB_ENTRIES = 10_000;
const TARGET_IDB_ENTRIES = 8_000;
const WRITES_PER_COMPACTION = 500;

export type SkPlaintextKind = 'channel' | 'dm';

/**
 * Which id space a messageId belongs to. `instanceDomain` is the
 * federated host that assigned the id, or null/undefined for home.
 */
export type SkPlaintextScope = {
  kind: SkPlaintextKind;
  instanceDomain?: string | null;
};

/**
 * One persisted row. `ciphertext` is the wire the plaintext was
 * decrypted from; `null` marks a legacy (pre-scoping) row that
 * carries no binding and is only ever surfaced for own messages.
 */
export type PersistedSkPlaintext = {
  ciphertext: string | null;
  plaintext: string;
};

function scopedKey(scope: SkPlaintextScope, messageId: number): string {
  return `${scope.instanceDomain || 'home'}:${scope.kind}:${messageId}`;
}

function legacyKey(messageId: number): string {
  return String(messageId);
}

/** Numeric messageId suffix of either key shape. */
function messageIdOfKey(key: string): number {
  return Number(key.slice(key.lastIndexOf(':') + 1));
}

const inMemoryByCiphertext = new Map<string, string>();

let dbInstance: IDBPDatabase | null = null;
let writesSinceLastCompact = 0;
let compactionInFlight: Promise<void> | null = null;

async function getDb(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance;
  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // v1 → v2 keeps the store and its rows (see DB_VERSION).
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
 * Persist the plaintext for `messageId` in `scope`, bound to the wire
 * it was decrypted from, so a reload can still render the message.
 * Idempotent overwrite — a re-decrypt after an edit replaces the
 * stale binding.
 *
 * Triggers lazy compaction every WRITES_PER_COMPACTION writes so the
 * IDB store can't grow unboundedly across long-lived sessions.
 */
export async function persistOwnPlaintextById(
  scope: SkPlaintextScope,
  messageId: number,
  ciphertext: string,
  plaintext: string
): Promise<void> {
  const db = await getDb();
  const entry: PersistedSkPlaintext = { ciphertext, plaintext };
  await db.put(STORE_NAME, entry, scopedKey(scope, messageId));

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
      // Both key shapes end in the messageId; sort on that so we drop
      // the genuinely-oldest rows rather than lexicographically. Ids
      // from different scopes are not comparable in the strict sense,
      // but "small id" is still the best available proxy for "old"
      // and this is a bounded cache, not a correctness surface.
      keys.sort((a, b) => messageIdOfKey(a) - messageIdOfKey(b));

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

function isPersistedEntry(value: unknown): value is PersistedSkPlaintext {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PersistedSkPlaintext).plaintext === 'string'
  );
}

/**
 * One IDB transaction for a whole page of ids. Every id is looked up
 * under its scoped key; the ids in `legacyFallbackIds` (the caller's
 * OWN messages — see DB_VERSION) are additionally looked up under the
 * pre-v2 bare key when the scoped lookup misses, and come back with
 * `ciphertext: null`.
 *
 * Entries are raw: resolve them against the current wire with
 * `resolvePersistedOwnPlaintext` before use.
 */
export async function getPersistedOwnPlaintextBatch(
  scope: SkPlaintextScope,
  messageIds: number[],
  legacyFallbackIds: Iterable<number> = []
): Promise<Map<number, PersistedSkPlaintext>> {
  if (messageIds.length === 0) return new Map();
  const legacy = new Set(legacyFallbackIds);
  const db = await getDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const result = new Map<number, PersistedSkPlaintext>();
  await Promise.all(
    messageIds.map(async (id) => {
      const scoped = await tx.store.get(scopedKey(scope, id));
      if (isPersistedEntry(scoped)) {
        result.set(id, scoped);
        return;
      }
      if (!legacy.has(id)) return;
      const bare = await tx.store.get(legacyKey(id));
      if (typeof bare === 'string') {
        result.set(id, { ciphertext: null, plaintext: bare });
      }
    })
  );
  await tx.done;
  return result;
}

/**
 * Turn a raw entry into a usable plaintext for `ciphertext`, or
 * undefined. A scoped entry bound to a different wire is a leftover
 * from before an edit: it is deleted here (awaited, so the caller's
 * subsequent persist of the fresh decrypt cannot be overtaken by the
 * delete) and the caller falls through to the chain. Legacy entries
 * carry no binding and are accepted as-is — the batch only produces
 * them for own messages.
 */
export async function resolvePersistedOwnPlaintext(
  scope: SkPlaintextScope,
  messageId: number,
  entry: PersistedSkPlaintext | undefined,
  ciphertext: string
): Promise<string | undefined> {
  if (!entry) return undefined;
  if (entry.ciphertext === null || entry.ciphertext === ciphertext) {
    return entry.plaintext;
  }
  await deletePersistedOwnPlaintext(scope, messageId).catch(() => {
    // best-effort — a stale row that survives just misses again
  });
  return undefined;
}

/**
 * Single-message form of the batch lookup + resolve. `allowLegacy`
 * must only be true for the caller's own messages.
 */
export async function getPersistedOwnPlaintextById(
  scope: SkPlaintextScope,
  messageId: number,
  ciphertext: string,
  allowLegacy: boolean
): Promise<string | undefined> {
  const batch = await getPersistedOwnPlaintextBatch(
    scope,
    [messageId],
    allowLegacy ? [messageId] : []
  );
  return resolvePersistedOwnPlaintext(
    scope,
    messageId,
    batch.get(messageId),
    ciphertext
  );
}

/**
 * Delete the scoped entry — used when the persisted ciphertext no
 * longer matches the message (the author edited it). Legacy rows are
 * never deleted individually; compaction and `clearAllOwnPlaintexts`
 * take care of them.
 */
export async function deletePersistedOwnPlaintext(
  scope: SkPlaintextScope,
  messageId: number
): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, scopedKey(scope, messageId));
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
