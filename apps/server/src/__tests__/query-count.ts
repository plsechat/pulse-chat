import { drizzle } from 'drizzle-orm/postgres-js';
import { activityLogQueue } from '../queues/activity-log';
import { dmMessageMetadataQueue } from '../queues/dm-message-metadata';
import { drainQueue } from '../queues/drain';
import { loginsQueue } from '../queues/logins';
import { messageMetadataQueue } from '../queues/message-metadata';
import { client, getTestDb, setTestDb } from './mock-db';

/**
 * Count the SQL statements `fn` issues through the application `db`
 * handle. Swaps the test database for a drizzle instance on the SAME
 * pool with a query logger (drizzle's logger fires once per executed
 * statement, transactions included) and restores it afterwards.
 *
 * The fire-and-forget queues are drained first so a straggling
 * activity-log insert from an earlier call is not counted against the
 * function under test. Nothing else may run concurrently in the window.
 */
const countQueries = async <T>(
  fn: () => Promise<T>
): Promise<{ result: T; queries: number; statements: string[] }> => {
  await Promise.all([
    drainQueue(activityLogQueue),
    drainQueue(loginsQueue),
    drainQueue(messageMetadataQueue),
    drainQueue(dmMessageMetadataQueue)
  ]);

  const previous = getTestDb();
  const statements: string[] = [];

  setTestDb(
    drizzle({
      client,
      logger: {
        logQuery: (query) => {
          statements.push(query);
        }
      }
    })
  );

  try {
    const result = await fn();
    return { result, queries: statements.length, statements };
  } finally {
    setTestDb(previous);
  }
};

export { countQueries };
