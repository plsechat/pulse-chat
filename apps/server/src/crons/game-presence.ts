import chalk from 'chalk';
import {
  expireStaleGamePresence,
  GAME_PRESENCE_TTL_MS
} from '../db/queries/game-presence';
import { logger } from '../logger';
import { announceGamePresence } from '../utils/game-presence';

/**
 * Game presence older than the TTL is a ghost: the shell that reported
 * it is gone (the last-socket clear in utils/game-presence.ts covers a
 * live server; this covers the timers a restart lost) or the session
 * really has run that long. Either way the rosters stop showing it, and
 * every cleared user is announced so they clear live. `now` is
 * injectable for the tick test.
 */
const expireGamePresenceTick = async (
  now: number = Date.now()
): Promise<number> => {
  const cleared = await expireStaleGamePresence(now, GAME_PRESENCE_TTL_MS);

  for (const userId of cleared) {
    await announceGamePresence(userId);
  }

  const summary = `Game presence expiry: cleared ${cleared.length} user(s).`;
  if (cleared.length > 0) {
    logger.info(`${chalk.dim('[Cron]')} ${summary}`);
  } else {
    logger.debug(`${chalk.dim('[Cron]')} ${summary}`);
  }

  return cleared.length;
};

export { expireGamePresenceTick };
