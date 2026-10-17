import type { TPollOptionView, TPollUpdate, TPollView } from '@pulse/server/types';

/**
 * Bar maths for the poll card. A single-choice poll shows each option's
 * share of all votes (they sum to 100); a multiple-choice poll shows the
 * share of VOTERS who picked the option (a voter can be in several bars,
 * so they do not sum). Percentages are whole numbers, 0 when nobody has
 * voted — never NaN into a width.
 */
export type TPollBar = {
  key: string;
  label: string;
  votes: number;
  percent: number;
  /** Highest count with at least one vote (ties all lead). */
  leading: boolean;
};

export const pollBars = (
  poll: Pick<TPollUpdate, 'options' | 'multiple' | 'totalVoters'>
): TPollBar[] => {
  const sum = poll.options.reduce((n, o) => n + o.votes, 0);
  const denominator = poll.multiple ? poll.totalVoters : sum;
  const top = Math.max(0, ...poll.options.map((o) => o.votes));

  return poll.options.map((option) => ({
    key: option.key,
    label: option.label,
    votes: option.votes,
    percent: denominator > 0 ? Math.round((option.votes / denominator) * 100) : 0,
    leading: top > 0 && option.votes === top
  }));
};

/**
 * Apply a POLL_UPDATE to the card's view. The update carries counts for
 * everyone and never the viewer's own choices, so those are kept from
 * the view the vote routes returned.
 */
export const mergePollUpdate = (view: TPollView, update: TPollUpdate): TPollView => ({
  ...view,
  ...update,
  ownVotes: view.ownVotes
});

/** `closesAt` as the card words it; null when the poll has no deadline. */
export const pollDeadlineLabel = (
  closesAt: number | null,
  closedAt: number | null,
  now: number
): string | null => {
  if (closedAt !== null) return 'Closed';
  if (closesAt === null) return null;
  const left = closesAt - now;
  if (left <= 0) return 'Closing';
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `Closes in ${minutes} min`;
  const hours = Math.round(left / 3_600_000);
  if (hours < 48) return `Closes in ${hours} h`;
  return `Closes in ${Math.round(left / 86_400_000)} days`;
};

/** The voters shown on hover: a bounded head of the list plus the rest as a count. */
export const voterPreview = (
  option: Pick<TPollOptionView, 'voterIds' | 'votes'>,
  max = 5
): { shown: number[]; more: number } => ({
  shown: option.voterIds.slice(0, max),
  more: Math.max(0, option.votes - Math.min(option.voterIds.length, max))
});
