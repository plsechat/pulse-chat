/**
 * Bounded attachment caches: decrypted object URLs are revoked on LRU
 * eviction and on logout; file keys are bounded the same way.
 *
 * Run via:
 *   bun test apps/client/src/lib/e2ee/__tests__/file-key-store.test.ts
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  clearFileKeys,
  getDecryptedFileUrl,
  getFileKeys,
  rememberDecryptedFileUrl,
  revokeAllDecryptedFileUrls,
  setFileKeys
} from '../file-key-store';

const originalRevoke = URL.revokeObjectURL;
let revoked: string[] = [];

beforeEach(() => {
  revoked = [];
  URL.revokeObjectURL = mock((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  revokeAllDecryptedFileUrls();
  clearFileKeys();
  URL.revokeObjectURL = originalRevoke;
});

describe('decrypted file URL cache', () => {
  test('evicting past the cap revokes the least recently used URL', () => {
    for (let i = 1; i <= 100; i++) {
      rememberDecryptedFileUrl(i, 1, `blob:${i}`);
    }
    expect(revoked).toEqual([]);

    // Touch #1 so it becomes most-recent; #2 is now the oldest.
    expect(getDecryptedFileUrl(1, 1)).toBe('blob:1');
    rememberDecryptedFileUrl(101, 1, 'blob:101');

    expect(revoked).toEqual(['blob:2']);
    expect(getDecryptedFileUrl(2, 1)).toBeUndefined();
    expect(getDecryptedFileUrl(1, 1)).toBe('blob:1');
    expect(getDecryptedFileUrl(101, 1)).toBe('blob:101');
  });

  test('replacing an attachment URL revokes the previous one', () => {
    rememberDecryptedFileUrl(5, 9, 'blob:old');
    rememberDecryptedFileUrl(5, 9, 'blob:new');
    expect(revoked).toEqual(['blob:old']);
    expect(getDecryptedFileUrl(5, 9)).toBe('blob:new');
  });

  test('revokeAllDecryptedFileUrls revokes and forgets everything (logout)', () => {
    rememberDecryptedFileUrl(1, 1, 'blob:a');
    rememberDecryptedFileUrl(2, 1, 'blob:b');
    revokeAllDecryptedFileUrls();
    expect(revoked.sort()).toEqual(['blob:a', 'blob:b']);
    expect(getDecryptedFileUrl(1, 1)).toBeUndefined();
    expect(getDecryptedFileUrl(2, 1)).toBeUndefined();
  });
});

describe('file key cache', () => {
  const keys = (n: number) => [
    { fileId: `f${n}`, key: `k${n}`, nonce: `n${n}`, mimeType: 'image/png' }
  ];

  test('is bounded and keeps recently read entries', () => {
    for (let i = 1; i <= 500; i++) setFileKeys(i, keys(i));
    expect(getFileKeys(1)).toEqual(keys(1)); // touch → most recent
    setFileKeys(501, keys(501));
    expect(getFileKeys(2)).toBeUndefined();
    expect(getFileKeys(1)).toEqual(keys(1));
    expect(getFileKeys(501)).toEqual(keys(501));
  });

  test('ignores empty key lists and clears on logout', () => {
    setFileKeys(7, []);
    setFileKeys(8, undefined);
    expect(getFileKeys(7)).toBeUndefined();
    setFileKeys(9, keys(9));
    clearFileKeys();
    expect(getFileKeys(9)).toBeUndefined();
  });
});
