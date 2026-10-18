/**
 * The client-side matcher behind search in an encrypted DM
 * (dm-search-match.ts): case-insensitive substring over the readable
 * text of decrypted messages, newest first, with the decrypt
 * placeholders never counting as a hit.
 *
 * Run via: bun test apps/client/src/screens/home-view/__tests__/dm-search-match.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TJoinedDmMessage } from '@pulse/server/types';
import {
  appendDmSearchHits,
  dmMessageMatches,
  matchDmMessages,
  normalizeDmSearchQuery
} from '../dm-search-match';

const msg = (
  id: number,
  content: string | null,
  createdAt = id * 1000
): TJoinedDmMessage =>
  ({
    id,
    dmChannelId: 1,
    userId: 2,
    content,
    createdAt,
    e2ee: true,
    files: [],
    reactions: []
  }) as unknown as TJoinedDmMessage;

describe('normalizeDmSearchQuery', () => {
  test('trims and lower-cases', () => {
    expect(normalizeDmSearchQuery('  Hello World ')).toBe('hello world');
    expect(normalizeDmSearchQuery('   ')).toBe('');
  });
});

describe('dmMessageMatches', () => {
  test('is a case-insensitive substring match', () => {
    expect(dmMessageMatches(msg(1, 'Meet at the Harbour'), 'harbour')).toBe(true);
    expect(dmMessageMatches(msg(1, 'Meet at the Harbour'), 'HARB')).toBe(true);
    expect(dmMessageMatches(msg(1, 'Meet at the Harbour'), 'marina')).toBe(false);
  });

  test('matches on readable text: mentions resolve, markdown markers drop', () => {
    // `<@12>` reads as "@user"; the bold markers are not part of the text.
    expect(dmMessageMatches(msg(1, 'ping <@12> **now**'), '@user')).toBe(true);
    expect(dmMessageMatches(msg(1, 'ping <@12> **now**'), 'now')).toBe(true);
    expect(dmMessageMatches(msg(1, 'ping <@12> **now**'), '**now**')).toBe(false);
    // Legacy HTML is stripped to its text before matching.
    expect(dmMessageMatches(msg(1, '<p>Tom &amp; Jerry</p>'), 'tom & jerry')).toBe(true);
    expect(dmMessageMatches(msg(1, '<p>Tom &amp; Jerry</p>'), '<p>')).toBe(false);
  });

  test('never matches empty content, an empty query, or a decrypt placeholder', () => {
    expect(dmMessageMatches(msg(1, null), 'x')).toBe(false);
    expect(dmMessageMatches(msg(1, ''), 'x')).toBe(false);
    expect(dmMessageMatches(msg(1, 'anything'), '')).toBe(false);
    expect(dmMessageMatches(msg(1, '[Unable to decrypt]'), 'decrypt')).toBe(false);
    expect(dmMessageMatches(msg(1, '[Encrypted message]'), 'encrypted')).toBe(false);
  });
});

describe('matchDmMessages', () => {
  test('returns the hits newest first and deduplicates by id', () => {
    const window = [
      msg(1, 'old harbour note'),
      msg(2, 'nothing here'),
      msg(3, 'Harbour again'),
      msg(3, 'Harbour again') // the slice/page seam can overlap
    ];
    expect(matchDmMessages(window, 'harbour').map((m) => m.id)).toEqual([3, 1]);
  });

  test('orders by createdAt before id', () => {
    const window = [msg(1, 'a', 5000), msg(2, 'a', 1000)];
    expect(matchDmMessages(window, 'a').map((m) => m.id)).toEqual([1, 2]);
  });

  test('a blank query yields nothing', () => {
    expect(matchDmMessages([msg(1, 'a')], '   ')).toEqual([]);
  });
});

describe('appendDmSearchHits', () => {
  test('appends older-page hits without duplicating ids', () => {
    const first = [msg(9, 'x'), msg(8, 'x')];
    const page = [msg(8, 'x'), msg(3, 'x')];
    expect(appendDmSearchHits(first, page).map((m) => m.id)).toEqual([9, 8, 3]);
  });
});
