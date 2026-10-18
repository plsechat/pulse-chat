/**
 * Poll bar maths: percentages per choice mode, leaders, deadline words,
 * and the merge that keeps the viewer's own votes across fan-outs.
 *
 * Run via: bun test apps/client/src/features/polls/__tests__/math.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { TPollView } from '@pulse/server/types';
import { mergePollUpdate, pollBars, pollDeadlineLabel, voterPreview } from '../math';

const option = (key: string, votes: number, voterIds: number[] = []) => ({
  key,
  label: key,
  votes,
  voterIds
});

describe('pollBars', () => {
  test('single choice: shares of all votes, rounded, leaders marked', () => {
    const bars = pollBars({
      multiple: false,
      totalVoters: 3,
      options: [option('a', 2), option('b', 1), option('c', 0)]
    });
    expect(bars.map((b) => b.percent)).toEqual([67, 33, 0]);
    expect(bars.map((b) => b.leading)).toEqual([true, false, false]);
  });

  test('multiple choice: shares of voters, so bars may exceed 100 together', () => {
    const bars = pollBars({
      multiple: true,
      totalVoters: 2,
      options: [option('a', 2), option('b', 2), option('c', 1)]
    });
    expect(bars.map((b) => b.percent)).toEqual([100, 100, 50]);
    expect(bars.map((b) => b.leading)).toEqual([true, true, false]);
  });

  test('no votes: every bar is 0 and nothing leads', () => {
    const bars = pollBars({ multiple: false, totalVoters: 0, options: [option('a', 0), option('b', 0)] });
    expect(bars.map((b) => b.percent)).toEqual([0, 0]);
    expect(bars.some((b) => b.leading)).toBe(false);
    expect(bars.every((b) => Number.isFinite(b.percent))).toBe(true);
  });
});

describe('mergePollUpdate', () => {
  test('takes the counts and keeps ownVotes', () => {
    const view: TPollView = {
      id: 1,
      messageId: 2,
      channelId: 3,
      question: 'q',
      options: [option('a', 1, [7])],
      multiple: false,
      anonymous: false,
      closesAt: null,
      closedAt: null,
      createdBy: 7,
      createdAt: 0,
      totalVoters: 1,
      ownVotes: ['a']
    };
    const merged = mergePollUpdate(view, {
      ...view,
      options: [option('a', 2, [7, 8])],
      totalVoters: 2,
      closedAt: 99
    } as never);
    expect(merged.options[0]!.votes).toBe(2);
    expect(merged.totalVoters).toBe(2);
    expect(merged.closedAt).toBe(99);
    expect(merged.ownVotes).toEqual(['a']);
  });
});

describe('pollDeadlineLabel', () => {
  const now = 1_000_000_000;
  test('closed, none, minutes, hours, days', () => {
    expect(pollDeadlineLabel(now + 1, now, now)).toBe('Closed');
    expect(pollDeadlineLabel(null, null, now)).toBeNull();
    expect(pollDeadlineLabel(now - 5, null, now)).toBe('Closing');
    expect(pollDeadlineLabel(now + 90_000, null, now)).toBe('Closes in 2 min');
    expect(pollDeadlineLabel(now + 5 * 3_600_000, null, now)).toBe('Closes in 5 h');
    expect(pollDeadlineLabel(now + 3 * 86_400_000, null, now)).toBe('Closes in 3 days');
  });
});

describe('voterPreview', () => {
  test('bounded head plus the remainder as a count, from the exact total', () => {
    expect(voterPreview(option('a', 8, [1, 2, 3, 4, 5, 6, 7, 8]))).toEqual({ shown: [1, 2, 3, 4, 5], more: 3 });
    expect(voterPreview(option('a', 2, [1, 2]))).toEqual({ shown: [1, 2], more: 0 });
    // The id list is capped server-side; the count is still exact.
    expect(voterPreview(option('a', 60, Array.from({ length: 50 }, (_, i) => i)))).toEqual({
      shown: [0, 1, 2, 3, 4],
      more: 55
    });
    // Anonymous: no ids at all, every voter is "more".
    expect(voterPreview(option('a', 3, []))).toEqual({ shown: [], more: 3 });
  });
});
