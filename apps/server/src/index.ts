// Data directories are created by config.ts at module-evaluation time
// (it is the first module in the import graph that writes to them).
// The "---------" comments keep prettier from reordering these imports.
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
import { warmFileHmacSecret } from './db/queries/server';
import { fileManager } from './utils/file-manager';
import { pluginManager } from './plugins';
import { loadBannedUsersCache } from './utils/banned-cache';
import { startMetricsSampler } from './utils/metrics';
import { enqueueActivityLog } from './queues/activity-log';
import { initVoiceRuntimes } from './runtimes';
import { createServers } from './utils/create-servers';
import { closeMediasoup, loadMediasoup } from './utils/mediasoup';
import { logger } from './logger';
import { printDebug } from './utils/print-debug';
import { activityLogQueue } from './queues/activity-log';
import { dmMessageMetadataQueue } from './queues/dm-message-metadata';
import { drainQueue } from './queues/drain';
import { loginsQueue } from './queues/logins';
import { messageMetadataQueue } from './queues/message-metadata';
import { VoiceRuntime } from './runtimes/voice';
import { db } from './db';
import { runShutdownSequence } from './utils/shutdown';
import type http from 'http';
import type { Sql } from 'postgres';

console.log('[pulse] Connecting to database...');
try {
  await loadDb();
  // Populate the banned-user cache before the HTTP/WS server accepts
  // traffic. Without this primer, the auth middleware's first batch
  // of `isBanned` calls would all return false until the first ban
  // mutation, which is fine but worth the millisecond-scale primer
  // to keep the cache truthful from request #1.
  await loadBannedUsersCache();
  // Warm the file-token HMAC secret (servers.secret_token, seeded by
  // loadDb on first boot). Every file-token mint/verify — private-channel
  // attachments, DM attachments — goes through getFileHmacSecretSync(),
  // which THROWS if nothing warmed the cache. Outside the test setup this
  // is the only warm call: without it, any file-token path 500s on a
  // freshly booted server (caught live in the test-deploy harness; latent
  // in v0.2.3 too).
  await warmFileHmacSecret();
} catch (e) {
  console.error('[pulse] FATAL: Database connection failed:', e);
  process.exit(1);
}

// Temp/upload leftovers from a previous process (timers do not survive a
// restart); sweep them before the first request can allocate a path.
// Non-fatal: a sweep failure must not take the server down.
try {
  const swept = await fileManager.sweepStaleFiles();
  if (swept > 0) logger.info(`Removed ${swept} stale upload file(s)`);
} catch (e) {
  logger.warn('Stale upload sweep failed: %o', e);
}

console.log('[pulse] Loading plugins...');
try {
  await pluginManager.loadPlugins();
} catch (e) {
  console.error('[pulse] FATAL: Plugin loading failed:', e);
  process.exit(1);
}

console.log('[pulse] Starting HTTP and WebSocket servers...');
let httpServer: http.Server;
try {
  httpServer = await createServers();
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

// Health-graph sampler — auxiliary observability, deliberately outside
// the fail-fast boot chain (a broken sampler must never stop the app).
startMetricsSampler();

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

// ── Graceful shutdown ────────────────────────────────────────────────
// Docker sends SIGTERM (STOPSIGNAL) on stop/upgrade; Ctrl-C is SIGINT.
// Without this, in-flight activity-log/login/preview writes, plugin
// `onUnload`, the mediasoup worker and the DB pool were all dropped
// mid-flight. The sequence lives in utils/shutdown.ts (unit-tested);
// this is only the wiring. Guarded so a second signal during the
// sequence does not start it twice.
const QUEUE_DRAIN_CAP_MS = 5000;
let shuttingDown = false;

const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info(`Received ${signal}, shutting down...`);

  void runShutdownSequence({
    closeHttp: () =>
      new Promise<void>((resolve) => {
        // Stop accepting; idle keep-alive sockets are released so
        // close() does not wait on them. Live WS sessions end with the
        // process — clients reconnect to the replacement.
        httpServer.close(() => resolve());
        httpServer.closeIdleConnections();
      }),
    drainQueues: async () => {
      await Promise.all(
        [
          activityLogQueue,
          loginsQueue,
          messageMetadataQueue,
          dmMessageMetadataQueue
        ].map((queue) => drainQueue(queue, QUEUE_DRAIN_CAP_MS))
      );
    },
    unloadPlugins: () => pluginManager.unloadPlugins(),
    destroyVoiceRuntimes: () => VoiceRuntime.destroyAll(),
    closeMediasoup: () => closeMediasoup(),
    // drizzle's postgres-js driver attaches the raw client as `$client`
    // (typed only on drizzle()'s return, not on PostgresJsDatabase).
    closeDb: () =>
      (db as typeof db & { $client: Sql }).$client.end({ timeout: 5 }),
    exit: (code) => process.exit(code),
    log: {
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
      error: (message) => logger.error(message)
    }
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
