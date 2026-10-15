import Queue from 'queue';
import { db } from '../../db';
import { logins } from '../../db/schema';
import { logger } from '../../logger';
import type { TConnectionInfo } from '../../types';
import { getIpInfo } from '../../utils/logins';

const loginsQueue = new Queue({
  concurrency: 1,
  autostart: true,
  timeout: 3000
});

loginsQueue.autostart = true;

// A rejected job (ipinfo timeout, insert failure) only surfaces as a
// queue 'error' event; without a listener the login row is dropped in
// silence. Log it — a missing login record is an operator-visible gap.
loginsQueue.addEventListener('error', (event) => {
  const error = event.detail.error;
  logger.warn(
    'Login record job failed: %s',
    error instanceof Error ? error.message : String(error)
  );
});

const enqueueLogin = (userId: number, info: TConnectionInfo | undefined) => {
  loginsQueue.push(async (callback) => {
    if (!info) {
      logger.warn('No connection info provided for login of user %d', userId);
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

    callback?.();
  });
};

// The instance is exported so the test harness can drain in-flight
// login writes before truncating tables (see __tests__/setup.ts).
export { enqueueLogin, loginsQueue };
