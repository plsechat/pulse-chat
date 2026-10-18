import Queue from 'queue';
import { db } from '../../db';
import { logins } from '../../db/schema';
import { logger } from '../../logger';
import type { TConnectionInfo } from '../../helpers/get-ws-info';
import { getIpInfo } from '../../utils/logins';

const loginsQueue = new Queue({
  concurrency: 1,
  autostart: true,
  timeout: 3000
});

loginsQueue.autostart = true;

// A rejected job makes queue@7 `end(error)` — every queued login record
// is discarded with it. Jobs catch their own failures below; this
// listener only remains for anything that still escapes, so a missing
// login record is never silent.
loginsQueue.addEventListener('error', (event) => {
  const error = event.detail.error;
  logger.warn(
    'Login record job failed: %s',
    error instanceof Error ? error.message : String(error)
  );
});

const enqueueLogin = (userId: number, info: TConnectionInfo | undefined) => {
  loginsQueue.push(async (callback) => {
    try {
      if (!info) {
        logger.warn(
          'No connection info provided for login of user %d',
          userId
        );
        callback?.();
        return;
      }
      const { ip, ...rest } = info;
      const ipInfo = ip ? await getIpInfo(ip) : undefined;

      await db
        .insert(logins)
        .values({
          userId,
          ip,
          ...rest,
          ...ipInfo,
          createdAt: Date.now()
        });
    } catch (error) {
      logger.warn(
        'Failed to record login of user %d: %s',
        userId,
        error instanceof Error ? error.message : String(error)
      );
    }

    callback?.();
  });
};

// The instance is exported so the test harness can drain in-flight
// login writes before truncating tables (see __tests__/setup.ts).
export { enqueueLogin, loginsQueue };
