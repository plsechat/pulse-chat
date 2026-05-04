/**
 * Plaintext-cache IDB compaction test. Validates that the lazy
 * compaction triggered by `persistOwnPlaintextById` prunes the
 * oldest (smallest-messageId) rows once the store exceeds the
 * soft cap, down to the target.
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
const STORE_NAME = 'plaintexts';

afterAll(async () => {
  // Clean up the IDB so re-running this test file doesn't carry
  // leftover state — the cache module's getDb() singleton would
  // otherwise resolve a polluted database for the next run.
  await clearAllOwnPlaintexts();
});

describe('plaintext-cache IDB compaction', () => {
  test('compacts when count crosses the threshold + write trigger', async () => {
    // Soft cap is 10_000 entries with a target of 8_000; compaction
    // re-fires every 500 writes. Pre-load enough entries to exceed
    // the cap, then trigger one more write to fire the lazy compact.
    // (Direct IDB writes here bypass the persist counter — that's
    // the point: we're emulating "previous session left a fat IDB"
    // and verifying the next write compacts.)
    const db = await openDB(DB_NAME, 1, {
      upgrade(d) {
        if (!d.objectStoreNames.contains(STORE_NAME)) {
          d.createObjectStore(STORE_NAME);
        }
      }
    });
    const tx = db.transaction(STORE_NAME, 'readwrite');
    for (let i = 0; i < 10_500; i++) {
      await tx.store.put(`plaintext-${i}`, String(i));
    }
    await tx.done;

    const beforeCount = await db.count(STORE_NAME);
    expect(beforeCount).toBe(10_500);
    db.close();

    // Trigger 500 writes via the public API to fire the compaction
    // path; each persist increments the counter.
    for (let i = 10_500; i < 11_000; i++) {
      await persistOwnPlaintextById(i, `plaintext-${i}`);
    }

    // Compaction is fire-and-forget; await its in-flight promise via
    // a small retry loop. 250ms is generous.
    let after = -1;
    for (let attempt = 0; attempt < 25; attempt++) {
      const dbCheck = await openDB(DB_NAME, 1);
      after = await dbCheck.count(STORE_NAME);
      dbCheck.close();
      if (after <= 8_000) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    // Compaction should have pruned down to TARGET_IDB_ENTRIES
    // (8_000) — the recent writes since then are well under that.
    expect(after).toBeLessThanOrEqual(8_000);

    // Verify the surviving rows are the *newest* (largest keys).
    const dbFinal = await openDB(DB_NAME, 1);
    const survivorKeys = ((await dbFinal.getAllKeys(
      STORE_NAME
    )) as string[])
      .map((k) => Number(k))
      .sort((a, b) => a - b);
    dbFinal.close();
    // Smallest survivor should be at least 11_000 - 8_000 = 3_000
    // (we pruned the oldest down to TARGET).
    expect(survivorKeys[0]).toBeGreaterThanOrEqual(3_000);
    expect(survivorKeys[survivorKeys.length - 1]).toBe(10_999);
  });
});
