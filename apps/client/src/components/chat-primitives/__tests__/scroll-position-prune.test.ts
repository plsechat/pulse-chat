import { describe, expect, test } from 'bun:test';
import {
  MAX_PERSISTED_POSITIONS,
  pruneToMostRecent
} from '@/components/chat-primitives/use-chat-scroll';

const entry = (n: number) => ({ scrollTop: n, atBottom: false });

describe('scroll position pruning', () => {
  test('keeps the most recently written entries up to the cap', () => {
    const map: Record<string, ReturnType<typeof entry>> = {};
    for (let i = 0; i < MAX_PERSISTED_POSITIONS + 50; i++) {
      map[`srv:${i}`] = entry(i);
    }
    const pruned = pruneToMostRecent(map, MAX_PERSISTED_POSITIONS);
    const keys = Object.keys(pruned);
    expect(keys.length).toBe(MAX_PERSISTED_POSITIONS);
    expect(keys[0]).toBe('srv:50');
    expect(keys[keys.length - 1]).toBe(`srv:${MAX_PERSISTED_POSITIONS + 49}`);
  });

  test('a re-written key counts as recent (moved to the tail)', () => {
    const map: Record<string, ReturnType<typeof entry>> = {};
    for (let i = 0; i < 4; i++) map[`dm:${i}`] = entry(i);
    // What rememberPosition does on every write.
    delete map['dm:0'];
    map['dm:0'] = entry(99);
    const pruned = pruneToMostRecent(map, 2);
    expect(Object.keys(pruned)).toEqual(['dm:3', 'dm:0']);
  });

  test('returns the same map untouched when under the cap', () => {
    const map = { 'srv:1': entry(1) };
    expect(pruneToMostRecent(map, 5)).toBe(map);
  });
});
