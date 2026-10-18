import { stringify } from 'ini';
import fs from 'node:fs/promises';
import { config } from '../config';
import { CONFIG_INI_PATH } from '../helpers/paths';
import { logger } from '../logger';

/**
 * The instance owner's switch for /federation/directory. Lives beside
 * the other federation policy in config.ini (not the settings table)
 * because it is federation policy: it means nothing while federation
 * is off, and the receiver reads it on every peer request.
 */

/** True when peers may read this instance's listed servers right now. */
const isDirectoryExposed = (): boolean =>
  config.federation.enabled && config.federation.exposeDirectory;

const setDirectoryExposed = async (exposed: boolean): Promise<void> => {
  config.federation.exposeDirectory = exposed;
  await fs.writeFile(
    CONFIG_INI_PATH,
    stringify(config as unknown as Record<string, unknown>)
  );
  logger.info('[directory] peers %s the directory', exposed ? 'may read' : 'are refused');
};

export { isDirectoryExposed, setDirectoryExposed };
