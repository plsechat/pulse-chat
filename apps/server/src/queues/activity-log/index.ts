import type { ActivityLogType, TActivityLogDetailsMap } from '@pulse/shared';
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

type TEnqueueActivityLog<T extends ActivityLogType = ActivityLogType> = {
  type: T;
  details?: TActivityLogDetailsMap[T];
  userId?: number;
  ip?: string;
  /** Scope for per-server audit reads (mod view). Omit for global events. */
  serverId?: number;
};

const enqueueActivityLog = <T extends ActivityLogType>({
  type,
  details = {} as TActivityLogDetailsMap[T],
  userId = 1,
  ip,
  serverId
}: TEnqueueActivityLog<T>) => {
  const date = Date.now();

  activityLogQueue.push(async (callback) => {
    const start = performance.now();

    // ip resolution must never kill the log write — getUserIp reads the
    // live socket map, which doesn't exist in tests and can race
    // disconnects in production.
    let resolvedIp: string | null = ip ?? null;
    if (!resolvedIp) {
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
      `${chalk.dim('[Activity Logger]')} Logged activity of type ${type} for user ${userId} in ${(performance.now() - start).toFixed(2)} ms`
    );

    callback?.();
  });
};

// The instance is exported so the test harness can drain in-flight
// log writes before truncating tables (see __tests__/setup.ts).
export { activityLogQueue, enqueueActivityLog };
