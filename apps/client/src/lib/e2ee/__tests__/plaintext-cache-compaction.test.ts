/**
 * Plaintext-cache IDB compaction test. Validates that the lazy
 * compaction triggered by `persistOwnPlaintextById` prunes the
 * oldest (smallest-messageId) rows once the store exceeds the
 * soft cap, down to the target — across BOTH key shapes the store
 * can hold (legacy bare `"<id>"` rows and scoped
 * `"<instance>:<kind>:<id>"` rows).
 *
 * Run via:
 *   bun test apps/client/src/lib/e2ee/__tests__/plaintext-cache-compaction.test.ts
 */

import 'fake-indexeddb/auto';
import { afterAll, describe, expect, test } from 'bun:test';
import { openDB } from 'idb';
import {
  clearAllOwnPlaintexts,
  persistOwnPlaintextById
} from '../plaintext-cache';

const DB_NAME = 'pulse-own-sk-plaintext';
const DB_VERSION = 2;
const STORE_NAME = 'plaintexts';
const SCOPE = { kind: 'channel' as const, instanceDomain: null };

const idOfKey = (k: string) => Number(k.slice(k.lastIndexOf(':') + 1));

afterAll(async () => {
  // Clean up the IDB so re-running this test file doesn't carry
  // leftover state — the cache module's getDb() singleton would
  // otherwise resolve a polluted database for the next run.
  await clearAllOwnPlaintexts();
});

describe('plaintext-cache IDB compaction', () => {
  test('compacts mixed legacy + scoped keys by numeric message id', async () => {
    // Soft cap is 10_000 entries with a target of 8_000; compaction
    // re-fires every 500 writes. Pre-load enough entries to exceed
    // the cap, then trigger one more write to fire the lazy compact.
    // (Direct IDB writes here bypass the persist counter — that's
    // the point: we're emulating "previous session left a fat IDB"
    // and verifying the next write compacts.) Odd ids are written as
    // pre-v2 legacy rows, even ids as scoped rows, so the sort has
    // to parse the numeric suffix of both shapes.
    const db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          d.createObjectStore(STORE_NAME);
        }
      }
    });
    const tx = db.transaction(STORE_NAME, 'readwrite');
    for (let i = 0; i < 10_500; i++) {
      if (i % 2 === 1) {
        await tx.store.put(`plaintext-${i}`, String(i));
      } else {
        await tx.store.put(
          { ciphertext: `ct-${i}`, plaintext: `plaintext-${i}` },
          `home:channel:${i}`
        );
      }
    }
    await tx.done;

    const beforeCount = await db.count(STORE_NAME);
    expect(beforeCount).toBe(10_500);
    db.close();

    // Trigger 500 writes via the public API to fire the compaction
    // path; each persist increments the counter.
    for (let i = 10_500; i < 11_000; i++) {
      await persistOwnPlaintextById(SCOPE, i, `ct-${i}`, `plaintext-${i}`);
    }

    // Compaction is fire-and-forget; await its in-flight promise via
    // a small retry loop. 250ms is generous.
    let after = -1;
    for (let attempt = 0; attempt < 25; attempt++) {
      const dbCheck = await openDB(DB_NAME, DB_VERSION);
      after = await dbCheck.count(STORE_NAME);
      dbCheck.close();
      if (after <= 8_000) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Compaction prunes down to TARGET_IDB_ENTRIES (8_000). The
    // write counter is module-global, so writes from earlier test
    // files in the same process may make it fire before the last of
    // our 500 writes lands; those late writes are the only slack.
    expect(after).toBeLessThanOrEqual(8_000 + 500);
    expect(after).toBeLessThan(10_500);

    // Verify the surviving rows are the *newest* (largest ids) and
    // that both key shapes survived in proportion — a lexicographic
    // sort would have thrown away every legacy row first.
    const dbFinal = await openDB(DB_NAME, DB_VERSION);
    const survivorKeys = (await dbFinal.getAllKeys(STORE_NAME)) as string[];
    dbFinal.close();
    const survivorIds = survivorKeys.map(idOfKey).sort((a, b) => a - b);
    // Compaction fired somewhere between write 1 and write 500 of our
    // loop, so it deleted between 2_501 and 3_000 of the oldest rows.
    expect(survivorIds[0]).toBeGreaterThanOrEqual(2_500);
    expect(survivorIds[survivorIds.length - 1]).toBe(10_999);
    const legacySurvivors = survivorKeys.filter((k) => !k.includes(':'));
    expect(legacySurvivors.length).toBeGreaterThan(2_500);
    expect(legacySurvivors.every((k) => idOfKey(k) >= 2_500)).toBe(true);
  });
});
