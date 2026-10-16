/**
 * Sender-key plaintext cache: key scoping, ciphertext binding and the
 * read-only legacy fallback for own messages.
 *
 * Run via:
 *   bun test apps/client/src/lib/e2ee/__tests__/plaintext-cache.test.ts
 */

import 'fake-indexeddb/auto';
import { afterEach, describe, expect, test } from 'bun:test';
import { openDB } from 'idb';
import {
  clearAllOwnPlaintexts,
  getPersistedOwnPlaintextBatch,
  getPersistedOwnPlaintextById,
  persistOwnPlaintextById,
  resolvePersistedOwnPlaintext
} from '../plaintext-cache';

const DB_NAME = 'pulse-own-sk-plaintext';
const DB_VERSION = 2;
const STORE_NAME = 'plaintexts';

const HOME_CHANNEL = { kind: 'channel' as const, instanceDomain: null };
const HOME_DM = { kind: 'dm' as const, instanceDomain: null };
const FED_CHANNEL = { kind: 'channel' as const, instanceDomain: 'a.example' };

/** Write a pre-v2 row the way the old module did: bare id, bare string. */
async function seedLegacyRow(messageId: number, plaintext: string) {
  const db = await openDB(DB_NAME, DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains(STORE_NAME)) {
        d.createObjectStore(STORE_NAME);
      }
    }
  });
  await db.put(STORE_NAME, plaintext, String(messageId));
  db.close();
}

async function rawKeys(): Promise<string[]> {
  const db = await openDB(DB_NAME, DB_VERSION);
  const keys = (await db.getAllKeys(STORE_NAME)) as string[];
  db.close();
  return keys;
}

afterEach(async () => {
  await clearAllOwnPlaintexts();
});

describe('plaintext-cache scoping', () => {
  test('channel 7 and group-DM 7 are different slots', async () => {
    await persistOwnPlaintextById(HOME_CHANNEL, 7, 'ct-channel', 'channel text');
    expect(
      await getPersistedOwnPlaintextById(HOME_DM, 7, 'ct-channel', false)
    ).toBeUndefined();
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 7, 'ct-channel', false)
    ).toBe('channel text');
  });

  test('a federated host id space does not alias home', async () => {
    await persistOwnPlaintextById(FED_CHANNEL, 7, 'ct-fed', 'federated text');
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 7, 'ct-fed', false)
    ).toBeUndefined();
    expect(
      await getPersistedOwnPlaintextById(FED_CHANNEL, 7, 'ct-fed', false)
    ).toBe('federated text');
    expect(await rawKeys()).toEqual(['a.example:channel:7']);
  });
});

describe('plaintext-cache ciphertext binding', () => {
  test('a different wire under the same id is a miss and drops the row', async () => {
    await persistOwnPlaintextById(HOME_CHANNEL, 1, 'ct-A', 'before edit');
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 1, 'ct-B', false)
    ).toBeUndefined();
    // The stale row is gone, so even the original wire misses now.
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 1, 'ct-A', false)
    ).toBeUndefined();
    expect(await rawKeys()).toEqual([]);
  });

  test('re-persisting after an edit replaces the binding', async () => {
    await persistOwnPlaintextById(HOME_CHANNEL, 1, 'ct-A', 'before edit');
    await persistOwnPlaintextById(HOME_CHANNEL, 1, 'ct-B', 'after edit');
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 1, 'ct-B', false)
    ).toBe('after edit');
    expect(await rawKeys()).toEqual(['home:channel:1']);
  });

  test('batch resolve applies the same rule per id', async () => {
    await persistOwnPlaintextById(HOME_DM, 1, 'ct-1', 'one');
    await persistOwnPlaintextById(HOME_DM, 2, 'ct-2-old', 'two-old');
    const batch = await getPersistedOwnPlaintextBatch(HOME_DM, [1, 2, 3]);
    expect(batch.size).toBe(2);
    expect(
      await resolvePersistedOwnPlaintext(HOME_DM, 1, batch.get(1), 'ct-1')
    ).toBe('one');
    expect(
      await resolvePersistedOwnPlaintext(HOME_DM, 2, batch.get(2), 'ct-2-new')
    ).toBeUndefined();
    expect(
      await resolvePersistedOwnPlaintext(HOME_DM, 3, batch.get(3), 'ct-3')
    ).toBeUndefined();
    expect(await rawKeys()).toEqual(['home:dm:1']);
  });
});

describe('plaintext-cache legacy fallback', () => {
  test('legacy rows are readable only when the caller allows it', async () => {
    await seedLegacyRow(42, 'pre-upgrade own text');
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 42, 'any-wire', false)
    ).toBeUndefined();
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 42, 'any-wire', true)
    ).toBe('pre-upgrade own text');
    // Reading never rewrites the row into the scoped shape.
    expect(await rawKeys()).toEqual(['42']);
  });

  test('a scoped row wins over a legacy row for the same id', async () => {
    await seedLegacyRow(42, 'legacy');
    await persistOwnPlaintextById(HOME_CHANNEL, 42, 'ct', 'scoped');
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 42, 'ct', true)
    ).toBe('scoped');
    // A mismatching wire drops the scoped row and does NOT fall back
    // to the legacy text (that would resurrect pre-edit content).
    expect(
      await getPersistedOwnPlaintextById(HOME_CHANNEL, 42, 'ct-edited', true)
    ).toBeUndefined();
  });

  test('batch only consults legacy rows for the listed own ids', async () => {
    await seedLegacyRow(10, 'own legacy');
    await seedLegacyRow(11, 'peer legacy');
    const batch = await getPersistedOwnPlaintextBatch(
      HOME_CHANNEL,
      [10, 11],
      [10]
    );
    expect(batch.get(10)).toEqual({ ciphertext: null, plaintext: 'own legacy' });
    expect(batch.has(11)).toBe(false);
    expect(
      await resolvePersistedOwnPlaintext(HOME_CHANNEL, 10, batch.get(10), 'w')
    ).toBe('own legacy');
  });
});
