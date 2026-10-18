import type { TImportSkipReasons, TImportStep } from '@pulse/server/types';

/** Plain names for the job's steps, in run order. */
const STEP_LABELS: Record<TImportStep, string> = {
  guild: 'Community details',
  categories: 'Categories',
  channels: 'Channels',
  roles: 'Roles',
  emojis: 'Emoji',
  members: 'Members',
  pins: 'Pins',
  threads: 'Threads',
  messages: 'Messages',
  events: 'Scheduled events'
};

const STEP_ORDER = Object.keys(STEP_LABELS) as TImportStep[];

const formatCount = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : value.toLocaleString();

/** "about 2 minutes", "about 1 hour 10 minutes" — never seconds-precise, it is an estimate. */
const formatDuration = (seconds: number): string => {
  if (seconds < 60) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `about ${hours} hour${hours === 1 ? '' : 's'}${rest > 0 ? ` ${rest} minute${rest === 1 ? '' : 's'}` : ''}`;
};

/**
 * "12 skipped (notices 10, empty 2)" for the messages step — what was
 * left behind and why, so a low count is not a mystery. Channels the
 * bot cannot read are a separate clause: those are whole channels, not
 * messages.
 */
const formatSkipped = (skipped: number, reasons: TImportSkipReasons | undefined): string => {
  const parts: string[] = [];
  if (skipped > 0) {
    const why = [
      reasons && reasons.type > 0 ? `notices ${formatCount(reasons.type)}` : '',
      reasons && reasons.empty > 0 ? `empty ${formatCount(reasons.empty)}` : ''
    ].filter((p) => p.length > 0);
    parts.push(`${formatCount(skipped)} skipped${why.length > 0 ? ` (${why.join(', ')})` : ''}`);
  }
  if (reasons && reasons.unreadable > 0) {
    parts.push(`${reasons.unreadable} channel${reasons.unreadable === 1 ? '' : 's'} unreadable`);
  }
  return parts.join(' · ');
};

export { formatCount, formatDuration, formatSkipped, STEP_LABELS, STEP_ORDER };
