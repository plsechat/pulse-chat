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
  stablePublicIdOf,
  __testing
} from '../safety-number';

const KEY_A = new Uint8Array(32).map((_, i) => (i + 1) & 0xff);
const KEY_B = new Uint8Array(32).map((_, i) => (i * 3 + 7) & 0xff);
const KEY_C = new Uint8Array(32).map((_, i) => (i * 5 + 11) & 0xff);

const PID_A = '0192f1a0-1111-7000-8000-00000000000a';
const PID_B = '0192f1a0-2222-7000-8000-00000000000b';
const PID_C = '0192f1a0-3333-7000-8000-00000000000c';

describe('computeSafetyNumber', () => {
  test('produces 60 decimal digits', async () => {
    const digits = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_B
    });
    expect(digits).toHaveLength(60);
    expect(/^\d{60}$/.test(digits)).toBe(true);
  });

  test('two endpoints compute the same number with sides swapped', async () => {
    const fromA = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_B
    });
    const fromB = await computeSafetyNumber({
      localPublicId: PID_B,
      localIdentityKey: KEY_B,
      remotePublicId: PID_A,
      remoteIdentityKey: KEY_A
    });
    expect(fromA).toBe(fromB);
  });

  test('deterministic: same inputs → same output', async () => {
    const inputs = {
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_C,
      remoteIdentityKey: KEY_C
    };
    const a = await computeSafetyNumber(inputs);
    const b = await computeSafetyNumber(inputs);
    expect(a).toBe(b);
  });

  test('changing the remote key changes the number', async () => {
    const original = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_B
    });
    const withNewRemoteKey = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_C
    });
    expect(withNewRemoteKey).not.toBe(original);
  });

  test('changing the local key changes the number', async () => {
    const original = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_B
    });
    const withNewLocalKey = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_C,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_B
    });
    expect(withNewLocalKey).not.toBe(original);
  });

  test('changing a stable id changes the number', async () => {
    const original = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_B
    });
    const withDifferentRemoteId = await computeSafetyNumber({
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_C,
      remoteIdentityKey: KEY_B
    });
    expect(withDifferentRemoteId).not.toBe(original);
  });

  test('a federated pair agrees: each side names the peer by the HOME publicId, whatever the local ids are', async () => {
    // Alice on instance A sees Bob as shadow #17 with Bob's home id in
    // federatedPublicId; Bob on instance B sees Alice as shadow #3.
    // Each side's own record is a plain local user.
    const aliceOnA = { id: 1, publicId: PID_A, federatedPublicId: null };
    const bobOnA = { id: 17, publicId: 'shadow-on-a-random', federatedPublicId: PID_B };
    const bobOnB = { id: 1, publicId: PID_B, federatedPublicId: null };
    const aliceOnB = { id: 3, publicId: 'shadow-on-b-random', federatedPublicId: PID_A };

    const aliceSees = await computeSafetyNumber({
      localPublicId: stablePublicIdOf(aliceOnA)!,
      localIdentityKey: KEY_A,
      remotePublicId: stablePublicIdOf(bobOnA)!,
      remoteIdentityKey: KEY_B
    });
    const bobSees = await computeSafetyNumber({
      localPublicId: stablePublicIdOf(bobOnB)!,
      localIdentityKey: KEY_B,
      remotePublicId: stablePublicIdOf(aliceOnB)!,
      remoteIdentityKey: KEY_A
    });
    expect(aliceSees).toBe(bobSees);

    // Hashing the shadow's locally minted publicId instead would not.
    const wrong = await computeSafetyNumber({
      localPublicId: aliceOnA.publicId,
      localIdentityKey: KEY_A,
      remotePublicId: bobOnA.publicId,
      remoteIdentityKey: KEY_B
    });
    expect(wrong).not.toBe(bobSees);
  });

  test('rejects missing public ids', async () => {
    await expect(
      computeSafetyNumber({
        localPublicId: '',
        localIdentityKey: KEY_A,
        remotePublicId: PID_B,
        remoteIdentityKey: KEY_B
      })
    ).rejects.toThrow();
  });

  test('rejects empty identity keys', async () => {
    await expect(
      computeSafetyNumber({
        localPublicId: PID_A,
        localIdentityKey: new Uint8Array(0),
        remotePublicId: PID_B,
        remoteIdentityKey: KEY_B
      })
    ).rejects.toThrow();
  });
});

describe('fingerprintFor (internal)', () => {
  test('produces exactly 30 truncated bytes', async () => {
    const fp = await __testing.fingerprintFor(PID_A, KEY_A);
    expect(fp.byteLength).toBe(__testing.TRUNCATED_BYTES);
  });

  test('changing identity key changes the fingerprint', async () => {
    const fpA = await __testing.fingerprintFor(PID_A, KEY_A);
    const fpB = await __testing.fingerprintFor(PID_A, KEY_B);
    expect(Buffer.from(fpA).toString('hex')).not.toBe(Buffer.from(fpB).toString('hex'));
  });

  test('changing the public id changes the fingerprint', async () => {
    const one = await __testing.fingerprintFor(PID_A, KEY_A);
    const two = await __testing.fingerprintFor(PID_B, KEY_A);
    expect(Buffer.from(one).toString('hex')).not.toBe(Buffer.from(two).toString('hex'));
  });
});

describe('stablePublicIdOf', () => {
  test('prefers the home id of a shadow, falls back to publicId, undefined when neither', () => {
    expect(stablePublicIdOf({ publicId: 'local-random', federatedPublicId: PID_B })).toBe(PID_B);
    expect(stablePublicIdOf({ publicId: PID_A, federatedPublicId: null })).toBe(PID_A);
    expect(stablePublicIdOf({ publicId: PID_A })).toBe(PID_A);
    expect(stablePublicIdOf({ publicId: '', federatedPublicId: '' })).toBeUndefined();
    expect(stablePublicIdOf(undefined)).toBeUndefined();
    expect(stablePublicIdOf(null)).toBeUndefined();
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
      localPublicId: PID_A,
      localIdentityKey: KEY_A,
      remotePublicId: PID_B,
      remoteIdentityKey: KEY_B
    });
    const formatted = formatForDisplay(digits);
    expect(formatted.split(' ')).toHaveLength(12);
    expect(formatted.replace(/ /g, '')).toBe(digits);
  });
});
