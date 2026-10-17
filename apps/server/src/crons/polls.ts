import { and, isNull, lte } from 'drizzle-orm';
import { db } from '../db';
import { closePoll, publishPollUpdate } from '../db/queries/polls';
import { polls } from '../db/schema';
import { logger } from '../logger';

/** Expired polls closed per tick; a backlog beyond this waits a minute. */
const TICK_BATCH = 500;

/**
 * Close every open poll whose deadline passed. The deadline itself is
 * persisted, so a missed minute or a restart closes it on the next
 * tick; closePoll's conditional UPDATE keeps a concurrent manual close
 * from publishing twice. Returns the number of polls closed.
 */
const closeExpiredPollsTick = async (now: number = Date.now()): Promise<number> => {
  const due = await db
    .select({ id: polls.id })
    .from(polls)
    .where(and(isNull(polls.closedAt), lte(polls.closesAt, now)))
    .limit(TICK_BATCH);

  let closed = 0;

  for (const { id } of due) {
    try {
      const poll = await closePoll(id, now);
      if (poll?.closedAt === now) {
        closed += 1;
        await publishPollUpdate(poll);
      }
    } catch (err) {
      logger.error('[polls] closing poll %d failed: %o', id, err);
    }
  }

  return closed;
};

export { closeExpiredPollsTick };
