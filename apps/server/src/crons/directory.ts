import chalk from 'chalk';
import { config } from '../config';
import { listActiveFederationInstances } from '../db/queries/federation';
import { pruneStaleDirectoryCache } from '../db/queries/directory';
import { logger } from '../logger';
import {
  syncDirectoryFromInstance,
  type TSyncMode
} from '../utils/directory-sync';

/**
 * Directory pulls from federated peers.
 *
 *   full    daily (and at boot): each active peer's listing replaces
 *           its cached rows, then rows no pull has refreshed in a week
 *           go (the peer stopped answering).
 *   counts  hourly: member/online counts of the cached rows, and the
 *           rows a peer delisted go.
 *
 * Peers are visited one at a time — each call is signed, verified and
 * capped at DIRECTORY_PEER_LIMIT rows, and a peer at the request
 * timeout must not hold the others' refresh. A failing peer is logged
 * and skipped; its cache stays until the stale prune.
 */
const directoryTick = async (
  mode: TSyncMode,
  now: number = Date.now()
): Promise<{ peers: number; failed: number; rows: number; removed: number; stale: number }> => {
  const summary = { peers: 0, failed: 0, rows: 0, removed: 0, stale: 0 };

  if (!config.federation.enabled) return summary;

  const instances = await listActiveFederationInstances();

  for (const instance of instances) {
    summary.peers += 1;
    try {
      const outcome = await syncDirectoryFromInstance(instance, mode, now);
      if (outcome.ok) {
        summary.rows += outcome.rows;
        summary.removed += outcome.removed;
      } else {
        summary.failed += 1;
        logger.debug('[directory] %s pull from %s: %s', mode, instance.domain, outcome.reason);
      }
    } catch (err) {
      summary.failed += 1;
      logger.warn('[directory] %s pull from %s threw: %o', mode, instance.domain, err);
    }
  }

  if (mode === 'full') {
    summary.stale = await pruneStaleDirectoryCache(now);
  }

  const line = `Directory ${mode}: ${summary.peers} peer(s), ${summary.failed} failed, ${summary.rows} row(s), ${summary.removed} delisted, ${summary.stale} stale.`;
  if (summary.rows > 0 || summary.removed > 0 || summary.stale > 0 || summary.failed > 0) {
    logger.info(`${chalk.dim('[Cron]')} ${line}`);
  } else {
    logger.debug(`${chalk.dim('[Cron]')} ${line}`);
  }

  return summary;
};

export { directoryTick };
