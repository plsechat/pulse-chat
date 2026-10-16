import chalk from 'chalk';
import { config } from '../config';
import { logger } from '../logger';
import { drainFederationOutbox } from '../utils/federation-outbox';

/**
 * Drains due `federation_outbox` rows (see utils/federation-outbox.ts
 * for the schedule). Runs every 30 s under its advisory lock, so a
 * tick that finds the previous one still delivering — a slow peer at
 * the 10 s request timeout — skips instead of double-sending.
 *
 * Returns the number of rows delivered.
 */
const drainOutboxTick = async (): Promise<number> => {
  if (!config.federation.enabled) return 0;

  const delivered = await drainFederationOutbox();
  if (delivered > 0) {
    logger.debug(
      `${chalk.dim('[Cron]')} Federation outbox: delivered ${delivered} row(s).`
    );
  }
  return delivered;
};

export { drainOutboxTick };
