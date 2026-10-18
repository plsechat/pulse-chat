import { MAX_FILES_PER_POST } from '@pulse/shared';

/**
 * How many of a fresh file selection still fit under the per-post cap,
 * given how many attachments the post already has. The dialog uploads
 * only `accepted` and tells the user about `dropped`, so the limit is
 * learnt while picking files instead of from a rejected submit.
 */
const splitByRemainingSlots = <T>(
  selected: readonly T[],
  attachedCount: number,
  max: number = MAX_FILES_PER_POST
): { accepted: T[]; dropped: number } => {
  const remaining = Math.max(0, max - attachedCount);
  return {
    accepted: selected.slice(0, remaining),
    dropped: Math.max(0, selected.length - remaining)
  };
};

export { splitByRemainingSlots };
