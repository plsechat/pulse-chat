import { describe, expect, test } from 'bun:test';
import type { TBridgeServerStatus } from '@pulse/server/types';
import {
  CREATE_MISSING_OPTIONS,
  createMissingLabel,
  DELETION_NOTE,
  describeSkipped,
  formatAgo,
  MODE_OPTIONS,
  modeLabel,
  summarizeCounts,
  summarizeSync
} from '../format';

const NOW = 1_760_000_000_000;

const report = (overrides: Partial<NonNullable<TBridgeServerStatus['sync']['last']>> = {}) => ({
  trigger: 'link' as const,
  startedAt: NOW - 70_000,
  finishedAt: NOW - 60_000,
  paired: 4,
  createdHere: 1,
  createdThere: 2,
  removed: 0,
  skipped: [],
  error: null,
  ...overrides
});

describe('server bridge copy', () => {
  test('every mode and create-missing choice has a label and a full sentence; labels resolve by value', () => {
    expect(MODE_OPTIONS.map((o) => o.value)).toEqual(['match', 'mirror']);
    expect(CREATE_MISSING_OPTIONS.map((o) => o.value)).toEqual(['both', 'here', 'there', 'none']);
    for (const option of [...MODE_OPTIONS, ...CREATE_MISSING_OPTIONS]) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.description.endsWith('.')).toBe(true);
    }
    expect(modeLabel('mirror')).toBe('Mirror');
    expect(createMissingLabel('there')).toBe('Only there');
    expect(DELETION_NOTE).toContain('never mirrored');
  });

  test('relative times read naturally', () => {
    expect(formatAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 60_000, NOW)).toBe('1 minute ago');
    expect(formatAgo(NOW - 5 * 60_000, NOW)).toBe('5 minutes ago');
    expect(formatAgo(NOW - 2 * 3_600_000, NOW)).toBe('2 hours ago');
    expect(formatAgo(NOW - 24 * 3_600_000, NOW)).toBe('yesterday');
    expect(formatAgo(NOW - 3 * 24 * 3_600_000, NOW)).toBe('3 days ago');
  });

  test('the sync line covers running, never ran, failed and the counts of the last run', () => {
    expect(summarizeSync({ running: true, last: null }, NOW)).toEqual({
      tone: 'busy',
      text: 'Pairing channels… this takes a moment per channel.'
    });
    expect(summarizeSync({ running: false, last: null }, NOW)).toEqual({ tone: 'muted', text: 'No sync has run yet.' });
    expect(summarizeSync({ running: false, last: report({ error: 'No bot token is configured' }) }, NOW)).toEqual({
      tone: 'warn',
      text: 'Last sync 1 minute ago failed: No bot token is configured'
    });
    expect(summarizeSync({ running: false, last: report() }, NOW)).toEqual({
      tone: 'ok',
      text: 'Last sync 1 minute ago: 4 channels paired, 1 created here, 2 created there.'
    });
    expect(
      summarizeSync(
        {
          running: false,
          last: report({ paired: 1, removed: 2, skipped: [{ name: 'x', side: 'here', reason: 'voice channel' }] })
        },
        NOW
      ).text
    ).toBe('Last sync 1 minute ago: 1 channel paired, 1 created here, 2 created there, 2 pairs ended, 1 skipped.');
  });

  test('counts drop the zero parts after the first; skipped lines name the side and the reason', () => {
    expect(summarizeCounts({ paired: 1, excluded: 0, manual: 0 })).toBe('1 channel paired');
    expect(summarizeCounts({ paired: 4, excluded: 1, manual: 2 })).toBe('4 channels paired · 1 excluded · 2 linked on their own');
    expect(summarizeCounts({ paired: 0, excluded: 0, manual: 1 })).toBe('0 channels paired · 1 linked on its own');
    expect(describeSkipped([{ name: 'Voice', side: 'there', reason: 'voice channel' }])).toEqual([
      '#Voice (there) — voice channel'
    ]);
  });
});
