import { describe, expect, test } from 'bun:test';
import { normalizeChannelName } from '../pairing';

/**
 * The same vectors are asserted by the server's copy
 * (apps/server/src/routers/__tests__/bridge-pairing.test.ts): a change
 * on one side without the other fails there.
 */
export const NORMALISATION_VECTORS: [string, string][] = [
  ['General Chat', 'general-chat'],
  ['general-chat', 'general-chat'],
  ['  Raids!! ', 'raids'],
  ['Café_Lounge', 'cafe-lounge'],
  ['off--topic', 'off-topic'],
  ['#news', 'news'],
  ['🎮 games', 'games'],
  ['___', ''],
  ['Ünïcödé Ñame', 'unicode-name']
];

describe('channel name normalisation (plugin copy)', () => {
  test('matches the server vectors', () => {
    for (const [input, expected] of NORMALISATION_VECTORS) {
      expect(normalizeChannelName(input)).toBe(expected);
    }
  });
});
