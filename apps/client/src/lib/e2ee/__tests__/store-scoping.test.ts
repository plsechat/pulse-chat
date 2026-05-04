/**
 * Per-instance scoping tests for SignalProtocolStore — specifically the
 * Phase C verifiedIdentities table.
 *
 * Bug this regression-tests: home and federated stores must each keep
 * their own verifiedIdentities. User IDs are per-instance — home
 * userId 5 is NOT the same person as federated userId 5 — so a TOFU
 * pin in one store must never leak across to the other. The Verify
 * Identity settings page and useVerifiedIdentity hook depend on this.
 *
 * Run via: bun test apps/client/src/lib/e2ee/__tests__/store-scoping.test.ts
 *
 * Uses fake-indexeddb to materialize a real IDB layer in-process — no
 * browser, no jsdom needed.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getStoreForInstance, SignalProtocolStore } from '../store';

const KEY_HOME_USER_5 = 'home-base64-pubkey-for-userid-5';
const KEY_FED_USER_5 = 'federated-base64-pubkey-for-userid-5';

beforeEach(async () => {
  // Wipe any IDBs left over from a prior test so each case starts fresh.
  // We don't tear down between tests by default, so explicitly clear
  // the stores we'll touch.
});

afterEach(async () => {
  // Clean up after each test by clearing the singleton stores. New
  // store instances created via `new SignalProtocolStore(name)` get
  // their own dbName, so their state doesn't leak — but the home
  // singleton from `getStoreForInstance(null)` would.
  const home = getStoreForInstance(null);
  await home.clearAll();
});

describe('SignalProtocolStore.verifiedIdentities — per-instance scoping', () => {
  test('home and federated stores keep distinct identity pins', async () => {
    const home = new SignalProtocolStore('test-home');
    const federated = new SignalProtocolStore('test-fed-1');

    await home.markIdentityTofu(5, KEY_HOME_USER_5);
    await federated.markIdentityTofu(5, KEY_FED_USER_5);

    const homeRow = await home.getVerifiedIdentity(5);
    const fedRow = await federated.getVerifiedIdentity(5);

    expect(homeRow?.identityPublicKey).toBe(KEY_HOME_USER_5);
    expect(fedRow?.identityPublicKey).toBe(KEY_FED_USER_5);
    expect(homeRow?.identityPublicKey).not.toBe(fedRow?.identityPublicKey);
  });

  test('listVerifiedIdentities returns only the calling store rows', async () => {
    const home = new SignalProtocolStore('test-home-2');
    const federated = new SignalProtocolStore('test-fed-2');

    await home.markIdentityTofu(5, KEY_HOME_USER_5);
    await home.markIdentityManual(7, 'home-key-7');
    await federated.markIdentityTofu(5, KEY_FED_USER_5);

    const homeList = await home.listVerifiedIdentities();
    const fedList = await federated.listVerifiedIdentities();

    expect(homeList).toHaveLength(2);
    expect(fedList).toHaveLength(1);

    const homeIds = homeList.map((e) => e.userId).sort();
    expect(homeIds).toEqual([5, 7]);
    expect(fedList[0].userId).toBe(5);
    expect(fedList[0].identityPublicKey).toBe(KEY_FED_USER_5);
  });

  test('clearVerifiedIdentity in one store does not affect the other', async () => {
    const home = new SignalProtocolStore('test-home-3');
    const federated = new SignalProtocolStore('test-fed-3');

    await home.markIdentityTofu(5, KEY_HOME_USER_5);
    await federated.markIdentityTofu(5, KEY_FED_USER_5);

    await home.clearVerifiedIdentity(5);

    expect(await home.getVerifiedIdentity(5)).toBeUndefined();
    expect((await federated.getVerifiedIdentity(5))?.identityPublicKey).toBe(
      KEY_FED_USER_5
    );
  });

  test('markIdentityManual overwrites a TOFU pin in same store', async () => {
    const home = new SignalProtocolStore('test-home-4');
    await home.markIdentityTofu(5, KEY_HOME_USER_5);
    const before = await home.getVerifiedIdentity(5);
    expect(before?.verifiedMethod).toBe('tofu');

    await home.markIdentityManual(5, KEY_HOME_USER_5);
    const after = await home.getVerifiedIdentity(5);
    expect(after?.verifiedMethod).toBe('manual');
    expect(after?.identityPublicKey).toBe(KEY_HOME_USER_5);
  });

  test('acceptIdentityChange replaces the pin under a new key', async () => {
    const home = new SignalProtocolStore('test-home-5');
    await home.markIdentityManual(5, 'old-key');

    await home.acceptIdentityChange(5, 'new-key');

    const row = await home.getVerifiedIdentity(5);
    expect(row?.identityPublicKey).toBe('new-key');
    // accept-change re-TOFUs (manual status is intentionally cleared so
    // the user re-confirms in person).
    expect(row?.verifiedMethod).toBe('tofu');
  });

  test('acceptIdentityChange sets acceptedChangeAt warning marker', async () => {
    const home = new SignalProtocolStore('test-home-6');
    await home.markIdentityTofu(5, 'old-key');
    const before = await home.getVerifiedIdentity(5);
    expect(before?.acceptedChangeAt).toBeUndefined();

    const t0 = Date.now();
    await home.acceptIdentityChange(5, 'new-key');

    const after = await home.getVerifiedIdentity(5);
    expect(after?.acceptedChangeAt).toBeDefined();
    expect(after?.acceptedChangeAt ?? 0).toBeGreaterThanOrEqual(t0);
  });

  test('markIdentityManual clears the acceptedChangeAt warning', async () => {
    const home = new SignalProtocolStore('test-home-7');
    await home.acceptIdentityChange(5, 'changed-key');
    const afterAccept = await home.getVerifiedIdentity(5);
    expect(afterAccept?.acceptedChangeAt).toBeDefined();

    await home.markIdentityManual(5, 'changed-key');
    const afterManual = await home.getVerifiedIdentity(5);
    expect(afterManual?.verifiedMethod).toBe('manual');
    expect(afterManual?.acceptedChangeAt).toBeUndefined();
  });

  test('markIdentityTofu (first-time pin) does not set acceptedChangeAt', async () => {
    const home = new SignalProtocolStore('test-home-8');
    await home.markIdentityTofu(5, 'first-key');
    const row = await home.getVerifiedIdentity(5);
    expect(row?.verifiedMethod).toBe('tofu');
    expect(row?.acceptedChangeAt).toBeUndefined();
  });
});

describe('getStoreForInstance — factory invariants', () => {
  test('returns home singleton for null/undefined domain', () => {
    const home1 = getStoreForInstance(null);
    const home2 = getStoreForInstance(null);
    expect(home1).toBe(home2);
  });

  test('returns same instance for repeat domain calls', () => {
    const fed1 = getStoreForInstance('a.example.com');
    const fed2 = getStoreForInstance('a.example.com');
    expect(fed1).toBe(fed2);
  });

  test('returns distinct instances per domain', () => {
    const fedA = getStoreForInstance('a.example.com');
    const fedB = getStoreForInstance('b.example.com');
    expect(fedA).not.toBe(fedB);
  });

  test('home store and federated store are distinct', () => {
    const home = getStoreForInstance(null);
    const fed = getStoreForInstance('a.example.com');
    expect(home).not.toBe(fed);
  });
});
