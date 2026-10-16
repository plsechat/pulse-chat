import type { ActivityLogType } from '@pulse/shared';
import type { TActivityLogDetailsMap } from '../../types';
import chalk from 'chalk';
import Queue from 'queue';
import { db } from '../../db';
import { activityLog } from '../../db/schema';
import { logger } from '../../logger';
import { getUserIp } from '../../utils/wss';

const activityLogQueue = new Queue({
  concurrency: 2,
  autostart: true,
  timeout: 3000
});

activityLogQueue.autostart = true;

// queue@7 reacts to a job error by calling `end(error)`, which discards
// EVERY job still queued. Each job below therefore catches its own
// failure and completes normally; this listener is the belt-and-braces
// for anything that still escapes (it would otherwise be silent).
activityLogQueue.addEventListener('error', (event) => {
  const error = event.detail.error;
  logger.error(
    'Activity log job failed: %s',
    error instanceof Error ? error.message : String(error)
  );
});

type TEnqueueActivityLog<T extends ActivityLogType = ActivityLogType> = {
  type: T;
  details?: TActivityLogDetailsMap[T];
  /** The acting user; omit (null) for system events with no human actor. */
  userId?: number | null;
  ip?: string;
  /** Scope for per-server audit reads (mod view). Omit for global events. */
  serverId?: number;
};

const enqueueActivityLog = <T extends ActivityLogType>({
  type,
  details = {} as TActivityLogDetailsMap[T],
  userId = null,
  ip,
  serverId
}: TEnqueueActivityLog<T>) => {
  const date = Date.now();

  activityLogQueue.push(async (callback) => {
    const start = performance.now();

    try {
      // ip resolution must never kill the log write — getUserIp reads the
      // live socket map, which doesn't exist in tests and can race
      // disconnects in production.
      let resolvedIp: string | null = ip ?? null;
      if (!resolvedIp && userId !== null) {
        try {
          resolvedIp = getUserIp(userId) || null;
        } catch {
          resolvedIp = null;
        }
      }

      await db.insert(activityLog).values({
        userId,
        type: type,
        details,
        ip: resolvedIp,
        serverId: serverId ?? null,
        createdAt: date
      });

      logger.debug(
        `${chalk.dim('[Activity Logger]')} Logged activity of type ${type} for user ${userId ?? 'system'} in ${(performance.now() - start).toFixed(2)} ms`
      );
    } catch (error) {
      logger.error(
        'Failed to write activity log entry %s for user %s: %s',
        type,
        userId ?? 'system',
        error instanceof Error ? error.message : String(error)
      );
    }

    callback?.();
  });
};

// The instance is exported so the test harness can drain in-flight
// log writes before truncating tables (see __tests__/setup.ts).
export { activityLogQueue, enqueueActivityLog };
