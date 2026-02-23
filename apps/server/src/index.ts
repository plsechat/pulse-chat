// these two imports NEED to be at the very top in this order
// keep the "---------" because it forces prettier to not mess with the order, I can't turn this off here for some reason, need to check later
import { ensureServerDirs } from './helpers/ensure-server-dirs';
await ensureServerDirs();
// ----------------------------------------
import { loadEmbeds } from './utils/embeds';
await loadEmbeds();
// ----------------------------------------
import { IS_PRODUCTION, SERVER_VERSION } from './utils/env';
// ----------------------------------------
import { ActivityLogType } from '@pulse/shared';
import chalk from 'chalk';
import { config, SERVER_PRIVATE_IP } from './config';
import { loadCrons } from './crons';
import { loadDb } from './db';
import { pluginManager } from './plugins';
import { enqueueActivityLog } from './queues/activity-log';
import { initVoiceRuntimes } from './runtimes';
import { createServers } from './utils/create-servers';
import { loadMediasoup } from './utils/mediasoup';
import { logger } from './logger';
import { printDebug } from './utils/print-debug';
import './utils/updater';

console.log('[pulse] Connecting to database...');
try {
  await loadDb();
} catch (e) {
  console.error('[pulse] FATAL: Database connection failed:', e);
  process.exit(1);
}

console.log('[pulse] Loading plugins...');
try {
  await pluginManager.loadPlugins();
} catch (e) {
  console.error('[pulse] FATAL: Plugin loading failed:', e);
  process.exit(1);
}

console.log('[pulse] Starting HTTP and WebSocket servers...');
try {
  await createServers();
} catch (e) {
  console.error('[pulse] FATAL: Server creation failed:', e);
  process.exit(1);
}

console.log('[pulse] Initializing mediasoup workers...');
try {
  await loadMediasoup();
} catch (e) {
  console.error('[pulse] FATAL: Mediasoup initialization failed:', e);
  process.exit(1);
}

console.log('[pulse] Initializing voice runtimes...');
try {
  await initVoiceRuntimes();
} catch (e) {
  console.error('[pulse] FATAL: Voice runtime initialization failed:', e);
  process.exit(1);
}

console.log('[pulse] Starting cron jobs...');
try {
  await loadCrons();
} catch (e) {
  console.error('[pulse] FATAL: Cron job initialization failed:', e);
  process.exit(1);
}

const host = IS_PRODUCTION ? SERVER_PRIVATE_IP : 'localhost';
const url = `http://${host}:${config.server.port}/`;

const message = [
  chalk.green.bold('PULSE') + ' ' + chalk.white.bold(`v${SERVER_VERSION}`),
  chalk.dim('────────────────────────────────────────────────────'),
  `${chalk.yellow('Port:')} ${chalk.bold(String(config.server.port))}`,
  `${chalk.yellow('Interface:')} ${chalk.underline.cyan(url)}`
].join('\n');

logger.info(message);

printDebug();

enqueueActivityLog({
  type: ActivityLogType.SERVER_STARTED
});
