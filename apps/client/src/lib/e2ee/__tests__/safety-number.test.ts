/**
 * Safety-number / numeric-fingerprint tests. Run via:
 *   bun test apps/client/src/lib/e2ee/__tests__/safety-number.test.ts
 *
 * No DB / network / DOM. Crypto is WebCrypto built-in to Bun.
 */

import { describe, expect, test } from 'bun:test';
import {
  computeSafetyNumber,
  formatForDisplay,
  __testing
} from '../safety-number';

const KEY_A = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
const KEY_B = new Uint8Array(32).map((_, i) => (i * 3 + 7) & 0xff);
const KEY_C = new Uint8Array(32).map((_, i) => (i * 5 + 11) & 0xff);

describe('computeSafetyNumber', () => {
  test('produces 60 decimal digits', async () => {
    const digits = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    expect(digits).toHaveLength(60);
    expect(/^\d{60}$/.test(digits)).toBe(true);
  });

  test('two endpoints compute the same number with sides swapped', async () => {
    const fromA = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    const fromB = await computeSafetyNumber({
      localUserId: 2,
      localIdentityKey: KEY_B,
      remoteUserId: 1,
      remoteIdentityKey: KEY_A
    });
    expect(fromA).toBe(fromB);
  });

  test('deterministic: same inputs → same output', async () => {
    const inputs = {
      localUserId: 42,
      localIdentityKey: KEY_A,
      remoteUserId: 99,
      remoteIdentityKey: KEY_C
    };
    const a = await computeSafetyNumber(inputs);
    const b = await computeSafetyNumber(inputs);
    expect(a).toBe(b);
  });

  test('changing the remote key changes the number', async () => {
    const original = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    const withNewRemoteKey = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_C
    });
    expect(withNewRemoteKey).not.toBe(original);
  });

  test('changing the local key changes the number', async () => {
    const original = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    const withNewLocalKey = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_C,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    expect(withNewLocalKey).not.toBe(original);
  });

  test('changing a stable id changes the number', async () => {
    const original = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    const withDifferentRemoteId = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 3,
      remoteIdentityKey: KEY_B
    });
    expect(withDifferentRemoteId).not.toBe(original);
  });

  test('numeric vs string user ids agree when string-equal', async () => {
    const numeric = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    const strings = await computeSafetyNumber({
      localUserId: '1',
      localIdentityKey: KEY_A,
      remoteUserId: '2',
      remoteIdentityKey: KEY_B
    });
    expect(numeric).toBe(strings);
  });

  test('rejects empty identity keys', async () => {
    await expect(
      computeSafetyNumber({
        localUserId: 1,
        localIdentityKey: new Uint8Array(0),
        remoteUserId: 2,
        remoteIdentityKey: KEY_B
      })
    ).rejects.toThrow();
  });
});

describe('fingerprintFor (internal)', () => {
  test('produces exactly 30 truncated bytes', async () => {
    const fp = await __testing.fingerprintFor('1', KEY_A);
    expect(fp.byteLength).toBe(__testing.TRUNCATED_BYTES);
  });

  test('changing identity key changes the fingerprint', async () => {
    const fpA = await __testing.fingerprintFor('1', KEY_A);
    const fpB = await __testing.fingerprintFor('1', KEY_B);
    expect(Buffer.from(fpA).toString('hex')).not.toBe(Buffer.from(fpB).toString('hex'));
  });

  test('changing stable id changes the fingerprint', async () => {
    const one = await __testing.fingerprintFor('1', KEY_A);
    const two = await __testing.fingerprintFor('2', KEY_A);
    expect(Buffer.from(one).toString('hex')).not.toBe(Buffer.from(two).toString('hex'));
  });
});

describe('chunksToDigits (internal)', () => {
  test('all-zero fingerprint → all zeros', () => {
    const digits = __testing.chunksToDigits(new Uint8Array(__testing.TRUNCATED_BYTES));
    expect(digits).toBe('0'.repeat(__testing.HALF_DIGITS));
  });

  test('5-byte chunk math: 0xFF FF FF FF FF mod 100000 = 92575', () => {
    const fp = new Uint8Array(__testing.TRUNCATED_BYTES);
    for (let i = 0; i < 5; i++) fp[i] = 0xff;
    const digits = __testing.chunksToDigits(fp);
    // 0xFFFFFFFFFF = 1099511627775; 1099511627775 % 100000 = 27775
    expect(digits.slice(0, 5)).toBe('27775');
    expect(digits.slice(5)).toBe('00000'.repeat(5));
  });

  test('rejects wrong-length input', () => {
    expect(() => __testing.chunksToDigits(new Uint8Array(29))).toThrow();
    expect(() => __testing.chunksToDigits(new Uint8Array(31))).toThrow();
  });
});

describe('formatForDisplay', () => {
  test('inserts spaces between 12 groups of 5', () => {
    const digits = '0'.repeat(60);
    const formatted = formatForDisplay(digits);
    expect(formatted).toBe('00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000');
  });

  test('preserves all input digits', () => {
    const digits = '123456789012345678901234567890123456789012345678901234567890';
    const formatted = formatForDisplay(digits);
    expect(formatted.replace(/ /g, '')).toBe(digits);
    expect(formatted.split(' ')).toHaveLength(12);
  });

  test('rejects non-60-digit input', () => {
    expect(() => formatForDisplay('123')).toThrow();
    expect(() => formatForDisplay('a'.repeat(60))).toThrow();
    expect(() => formatForDisplay('1'.repeat(59))).toThrow();
    expect(() => formatForDisplay('1'.repeat(61))).toThrow();
  });
});

describe('integration: end-to-end format', () => {
  test('computeSafetyNumber output passes formatForDisplay', async () => {
    const digits = await computeSafetyNumber({
      localUserId: 1,
      localIdentityKey: KEY_A,
      remoteUserId: 2,
      remoteIdentityKey: KEY_B
    });
    const formatted = formatForDisplay(digits);
    expect(formatted.split(' ')).toHaveLength(12);
    expect(formatted.replace(/ /g, '')).toBe(digits);
  });
});
