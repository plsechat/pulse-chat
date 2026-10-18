/**
 * The per-post attachment cap as the create dialog applies it: a
 * selection is cut to the slots left, and the overflow is counted so
 * the user can be told.
 *
 * Run via: bun test apps/client/src/components/channel-view/forum/__tests__/forum-post-limits.test.ts
 */

import { MAX_FILES_PER_POST } from '@pulse/shared';
import { describe, expect, test } from 'bun:test';
import { splitByRemainingSlots } from '../forum-post-limits';

const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}`);

describe('splitByRemainingSlots', () => {
  test('a selection that fits is accepted whole', () => {
    expect(splitByRemainingSlots(files(3), 0)).toEqual({
      accepted: ['f0', 'f1', 'f2'],
      dropped: 0
    });
  });

  test('cuts to the remaining slots and counts the overflow', () => {
    const { accepted, dropped } = splitByRemainingSlots(files(5), 8);
    expect(accepted).toEqual(['f0', 'f1']);
    expect(dropped).toBe(3);
  });

  test('nothing fits once the post is full', () => {
    expect(splitByRemainingSlots(files(2), MAX_FILES_PER_POST)).toEqual({
      accepted: [],
      dropped: 2
    });
    // over-full (should not happen, but must not go negative)
    expect(splitByRemainingSlots(files(1), MAX_FILES_PER_POST + 4)).toEqual({
      accepted: [],
      dropped: 1
    });
  });

  test('defaults to the shared per-post cap', () => {
    const { accepted, dropped } = splitByRemainingSlots(
      files(MAX_FILES_PER_POST + 1),
      0
    );
    expect(accepted).toHaveLength(MAX_FILES_PER_POST);
    expect(dropped).toBe(1);
  });
});
