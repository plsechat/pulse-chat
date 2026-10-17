import { describe, expect, test } from 'bun:test';
import { communityHue } from '../community-hue';

describe('communityHue', () => {
  test('is stable for the same seed and differs across seeds', () => {
    expect(communityHue('srv_abc')).toBe(communityHue('srv_abc'));
    const hues = new Set(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => communityHue(s))
    );
    expect(hues.size).toBeGreaterThan(5);
  });

  test('stays inside the allowed band', () => {
    for (let i = 0; i < 500; i++) {
      const hue = communityHue(`seed-${i}`);
      expect(hue).toBeGreaterThanOrEqual(25);
      expect(hue).toBeLessThan(345);
    }
  });

  test('an empty seed falls back to the brand hue', () => {
    expect(communityHue('')).toBe(190);
  });
});
