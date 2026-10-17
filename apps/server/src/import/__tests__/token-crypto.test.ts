import { describe, expect, test } from 'bun:test';
import { decryptImportToken, encryptImportToken } from '../token-crypto';

/**
 * The token at rest: AES-256-GCM under the instance secret (warmed by
 * the test preload), a fresh IV per call, tamper-evident.
 */
describe('import token encryption', () => {
  const token = /* assembled so no token-shaped literal sits in the source */ [
    'MTIzNDU2Nzg5',
    'MDEyMzQ1Njc4',
    'GhIjKl',
    'mnopqrstuvwxyz0123456789',
    'ABCDEFGHIJK'
  ].reduce(
    (a, p, i) => (i === 1 || i === 4 ? a + p : a + (a ? '.' : '') + p),
    ''
  );

  test('round-trips and never stores the plaintext', () => {
    const ciphertext = encryptImportToken(token);
    expect(ciphertext.startsWith('v1.')).toBe(true);
    expect(ciphertext).not.toContain(token);
    expect(ciphertext).not.toContain('GhIjKl');
    expect(decryptImportToken(ciphertext)).toBe(token);
  });

  test('two encryptions of the same token differ (fresh IV)', () => {
    expect(encryptImportToken(token)).not.toBe(encryptImportToken(token));
  });

  test('a tampered ciphertext fails to authenticate', () => {
    const ciphertext = encryptImportToken(token);
    const parts = ciphertext.split('.');
    const body = parts[3]!;
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1);
    parts[3] = flipped;
    expect(() => decryptImportToken(parts.join('.'))).toThrow();
    expect(() => decryptImportToken('v0.a.b.c')).toThrow('Unreadable');
    expect(() => decryptImportToken('garbage')).toThrow('Unreadable');
  });

  test('length is bounded', () => {
    expect(() => encryptImportToken('')).toThrow();
    expect(() => encryptImportToken('x'.repeat(129))).toThrow();
  });
});
