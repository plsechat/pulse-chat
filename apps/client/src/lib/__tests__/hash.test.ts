import { describe, expect, test } from 'bun:test';
import { hash32 } from '../hash';

describe('hash32', () => {
  test('is stable for the same input and spreads across inputs', () => {
    expect(hash32('usr_abc')).toBe(hash32('usr_abc'));
    const buckets = new Set(
      Array.from({ length: 64 }, (_, i) => hash32(`seed-${i}`) % 8)
    );
    expect(buckets.size).toBeGreaterThan(4);
  });

  test('always yields an unsigned 32-bit integer', () => {
    for (const s of ['', 'a', 'ünïcode', 'x'.repeat(500)]) {
      const h = hash32(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
