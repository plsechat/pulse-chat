import chalk from 'chalk';
import { ChannelType, ServerEvents } from '@pulse/shared';
import { and, eq, lt, sql } from 'drizzle-orm';
import { db } from '../db';
import { publishChannel } from '../db/publishers';
import { ACTIVE_STATUSES } from '../db/queries/import-jobs';
import { getServerMemberIds } from '../db/queries/servers';
import { channels, importJobs, messages } from '../db/schema';
import { logger } from '../logger';
import { pubsub } from '../utils/pubsub';

// Minimum age before a zero-message thread is considered abandoned.
// 10 minutes — long enough for a user who clicked Create Thread by
// accident to back out manually via the new creator-can-delete-empty
// affordance, short enough that the strays don't accumulate. Forum
// posts (THREAD with FORUM parent) ALWAYS have at least one message
// (the post body), so this filter naturally skips them.
const MIN_AGE_MS = 10 * 60 * 1000;

/**
 * Periodic cleanup for THREAD channels that were created but never
 * had a message posted in them. Two paths produce these:
 *   1. User opened the message-context Create Thread, never typed,
 *      backed out without using the manual delete (or didn't have
 *      that affordance pre-26c3706).
 *   2. Programmatic thread creation that failed mid-flight after the
 *      channel row was inserted but before the seed message landed.
 *
 * A community import is a third source of empty threads that must NOT
 * be swept: its threads step creates every thread row first and the
 * messages step fills them later — more than ten minutes later on a
 * big history. Threads of a server with an import in flight (pending,
 * running or paused) are left alone; the first thread message of a
 * swept thread would otherwise fail the whole job on the channel
 * foreign key.
 *
 * Cascades take care of follow rows, forum tag pivots, and
 * sender-key rows (all reference channels.id with ON DELETE CASCADE).
 * `now` is injectable for the tick test.
 */
const cleanupEmptyThreads = async (now: number = Date.now()) => {
  logger.debug(`${chalk.dim('[Cron]')} Scanning for empty threads...`);

  const cutoff = now - MIN_AGE_MS;
  const activeStatuses = sql.join(
    ACTIVE_STATUSES.map((status) => sql`${status}`),
    sql`, `
  );

  // Threads with zero rows in `messages` where messages.channel_id =
  // channels.id. Use a NOT EXISTS subquery so we don't materialize
  // counts for channels that have hundreds of messages.
  const emptyThreads = await db
    .select({
      id: channels.id,
      serverId: channels.serverId,
      parentChannelId: channels.parentChannelId
    })
    .from(channels)
    .where(
      and(
        eq(channels.type, ChannelType.THREAD),
        lt(channels.createdAt, cutoff),
        sql`NOT EXISTS (
          SELECT 1 FROM ${messages}
          WHERE ${messages.channelId} = ${channels.id}
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${importJobs}
          WHERE ${importJobs.serverId} = ${channels.serverId}
            AND ${importJobs.status} IN (${activeStatuses})
        )`
      )
    );

  if (emptyThreads.length === 0) {
    logger.debug(`${chalk.dim('[Cron]')} No empty threads to clean up.`);
    return;
  }

  logger.info(
    `${chalk.dim('[Cron]')} Found ${emptyThreads.length} empty thread(s) older than ${MIN_AGE_MS / 1000}s. Removing.`
  );

  for (const thread of emptyThreads) {
    try {
      await db.delete(channels).where(eq(channels.id, thread.id));
      publishChannel(thread.id, 'delete', thread.serverId);
      const memberIds = await getServerMemberIds(thread.serverId);
      pubsub.publishFor(memberIds, ServerEvents.THREAD_DELETE, thread.id);
    } catch (err) {
      logger.error(
        `${chalk.dim('[Cron]')} Failed to delete empty thread %d: %o`,
        thread.id,
        err
      );
    }
  }

  logger.info(
    `${chalk.dim('[Cron]')} Cleaned up ${emptyThreads.length} empty thread(s).`
  );
};

export { cleanupEmptyThreads };
