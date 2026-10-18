import type {
  TBridgeCreateMissing,
  TBridgeMode,
  TBridgeServerStatus,
  TBridgeSyncReport
} from '@pulse/server/types';

/**
 * Pure copy helpers for Server Settings → Bridge: what each pairing
 * mode and each "create missing" choice means, and the one-line
 * summaries of the last sync and the counts. Kept apart from the
 * component so the wording has a unit test.
 */

export type TModeOption = { value: TBridgeMode; label: string; description: string };

export const MODE_OPTIONS: TModeOption[] = [
  {
    value: 'match',
    label: 'Match by name',
    description:
      'Text and announcement channels with the same name on both sides are paired. Nothing is created.'
  },
  {
    value: 'mirror',
    label: 'Mirror',
    description:
      'Same-name channels are paired, and channels that exist on one side only are created on the other, in a category of the same name.'
  }
];

export type TCreateMissingOption = {
  value: TBridgeCreateMissing;
  label: string;
  description: string;
};

export const CREATE_MISSING_OPTIONS: TCreateMissingOption[] = [
  {
    value: 'both',
    label: 'On both sides',
    description: 'A channel missing here is created here; one missing there is created there.'
  },
  {
    value: 'here',
    label: 'Only here',
    description: 'Channels that exist only over there are created here. Nothing is created there.'
  },
  {
    value: 'there',
    label: 'Only there',
    description: 'Channels that exist only here are created there. Nothing is created here.'
  },
  {
    value: 'none',
    label: 'Nowhere',
    description: 'Only same-name channels pair — the same as matching by name.'
  }
];

export const modeLabel = (mode: TBridgeMode): string =>
  MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;

export const createMissingLabel = (value: TBridgeCreateMissing): string =>
  CREATE_MISSING_OPTIONS.find((option) => option.value === value)?.label ?? value;

/** Said once, where the owner links: deletions never cross the bridge. */
export const DELETION_NOTE =
  'Deleting a channel on either side only ends its pair; the channel on the other side stays. Deletions are never mirrored.';

/** "just now", "3 minutes ago", "2 hours ago", "yesterday", else the date. */
export const formatAgo = (at: number, now: number): string => {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString();
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The sync line: running, the last result, or the fact that none ran yet. */
export const summarizeSync = (
  sync: TBridgeServerStatus['sync'],
  now: number
): { tone: 'ok' | 'warn' | 'muted' | 'busy'; text: string } => {
  if (sync.running) {
    return { tone: 'busy', text: 'Pairing channels… this takes a moment per channel.' };
  }

  const last = sync.last;
  if (!last || last.finishedAt === null) {
    return { tone: 'muted', text: 'No sync has run yet.' };
  }

  if (last.error) {
    return { tone: 'warn', text: `Last sync ${formatAgo(last.finishedAt, now)} failed: ${last.error}` };
  }

  const parts = [
    plural(last.paired, 'channel paired', 'channels paired'),
    plural(last.createdHere, 'created here', 'created here'),
    plural(last.createdThere, 'created there', 'created there')
  ];
  if (last.removed > 0) parts.push(plural(last.removed, 'pair ended', 'pairs ended'));
  if (last.skipped.length > 0) parts.push(plural(last.skipped.length, 'skipped', 'skipped'));

  return { tone: 'ok', text: `Last sync ${formatAgo(last.finishedAt, now)}: ${parts.join(', ')}.` };
};

/** "4 channels paired · 1 excluded · 2 linked on their own" (zero parts after the first are dropped). */
export const summarizeCounts = (counts: TBridgeServerStatus['counts']): string => {
  const parts = [plural(counts.paired, 'channel paired', 'channels paired')];
  if (counts.excluded > 0) parts.push(plural(counts.excluded, 'excluded', 'excluded'));
  if (counts.manual > 0) {
    parts.push(counts.manual === 1 ? '1 linked on its own' : `${counts.manual} linked on their own`);
  }
  return parts.join(' · ');
};

/** One line per skipped channel: "#name (here) — reason". */
export const describeSkipped = (skipped: TBridgeSyncReport['skipped']): string[] =>
  skipped.map((entry) => `#${entry.name} (${entry.side}) — ${entry.reason}`);
