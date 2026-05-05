import path from 'path';
import { createLogger, format, transports, type Logger as WinstonLogger } from 'winston';
import { config } from './config';
import { ensureDir } from './helpers/fs';
import { LOGS_PATH } from './helpers/paths';
import { getLogContext } from './utils/log-context';
import { redact } from './utils/log-redact';

declare module 'winston' {
  interface Logger {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    time: (key: string, message?: string, ...meta: any[]) => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    timeEnd: (key: string, message?: string, ...meta: any[]) => void;
  }
}

const { combine, colorize, printf, errors, splat, timestamp, json, uncolorize } = format;

const consoleFormat = printf(({ level, message, stack }) => {
  return `${level}: ${stack || message}`;
});

const appLog = path.join(LOGS_PATH, 'app.log');
const errorLog = path.join(LOGS_PATH, 'error.log');
const debugLog = path.join(LOGS_PATH, 'debug.log');

await ensureDir(LOGS_PATH);

// `level` reflects the *current* verbosity — bumped by SIGUSR1 / setDebugVerbose
// at runtime. Initial state mirrors `config.server.debug`.
let currentLevel: 'debug' | 'info' = config.server.debug ? 'debug' : 'info';

/**
 * File-side format chain. Adds the active log-context fields, redacts
 * sensitive shapes, and serializes to one-line JSON. Splunk-friendly,
 * jq-greppable. Body inclusion is controlled by `DEBUG_LOG_INCLUDE_BODY`.
 *
 * Note: the logger's default format runs first (it owns colorize +
 * splat for the console output). By the time this transport-specific
 * format sees `info`, the message is already substituted and `level`
 * is wrapped in ANSI escape codes. We:
 *   - `uncolorize()` strips the ANSI from `level` / `message`
 *   - skip a second `splat()` call (the default format already did it
 *     once; running it twice is what caused numeric-key pollution
 *     of the JSON output via Object.assign(info, ...args))
 *   - explicitly rebuild the payload from known fields so any stray
 *     numeric properties from earlier passes don't leak into the JSON
 */
const fileJsonFormat = combine(
  uncolorize(),
  errors({ stack: true }),
  timestamp(),
  format((info) => {
    const ctx = getLogContext();

    // Strip stray numeric-keyed properties left on info by winston's
    // splat-merge of primitive args (Object.assign(info, "select…")
    // spreads each character as info[0]='s', info[1]='e', ...).
    for (const k of Object.keys(info)) {
      if (/^\d+$/.test(k)) {
        delete (info as Record<string, unknown>)[k];
      }
    }

    if (ctx) {
      info.requestId = ctx.requestId;
      if (ctx.userId !== undefined) info.userId = ctx.userId;
      if (ctx.route) info.route = ctx.route;
      if (ctx.instanceDomain) info.instanceDomain = ctx.instanceDomain;
    }

    if (!config.server.debugLogIncludeBody) {
      // Body off — strip everything except the canonical envelope.
      const {
        level,
        message,
        timestamp: ts,
        requestId,
        userId,
        route,
        instanceDomain,
        stack
      } = info as Record<string, unknown> & { level: string; message: string };
      return {
        level,
        message,
        timestamp: ts,
        requestId,
        userId,
        route,
        instanceDomain,
        stack
      } as typeof info;
    }

    return redact(info);
  })(),
  json()
);

const consoleTransport = new transports.Console({ level: currentLevel });
const appFileTransport = new transports.File({
  filename: appLog,
  level: currentLevel
});
const errorFileTransport = new transports.File({
  filename: errorLog,
  level: 'error'
});

// Debug file transport is only attached when verbose logging is on. Lazily
// constructed on first activation so a server that boots with debug=off
// never opens debug.log (verifiable by `lsof` / fs spy in tests).
let debugFileTransport: ReturnType<typeof buildDebugFileTransport> | null = null;

function buildDebugFileTransport() {
  return new transports.File({
    filename: debugLog,
    level: 'debug',
    format: fileJsonFormat,
    // Winston's built-in size-based rotation: when the active file
    // crosses `maxsize`, it's renamed to `<name>1.log`, then `<name>2.log`,
    // etc., up to `maxFiles`. Older files are deleted.
    maxsize: config.server.debugLogMaxSizeMb * 1024 * 1024,
    maxFiles: config.server.debugLogMaxFiles,
    tailable: true
  });
}

const baseTransports = [
  consoleTransport,
  appFileTransport,
  errorFileTransport
];

const logger = createLogger({
  level: currentLevel,
  // Default format applies to console + app.log + error.log. Plain
  // human-readable; the JSON format is set per-transport on debugFile.
  format: combine(colorize(), splat(), errors({ stack: true }), consoleFormat),
  transports: baseTransports
}) as WinstonLogger;

if (config.server.debug) {
  attachDebugFileTransport();
}

function attachDebugFileTransport(): void {
  if (debugFileTransport) return;
  debugFileTransport = buildDebugFileTransport();
  logger.add(debugFileTransport);
}

function applyLevel(level: 'debug' | 'info'): void {
  currentLevel = level;
  logger.level = level;
  consoleTransport.level = level;
  appFileTransport.level = level;
  // error transport stays at 'error'
  if (debugFileTransport) {
    debugFileTransport.level = 'debug';
  }
}

/**
 * Programmatically toggle verbose logging at runtime. Used by the
 * SIGUSR1 handler and (later) by an admin tRPC mutation. When turning
 * on, lazily attaches the debug.log file transport if not already.
 */
export function setDebugVerbose(on: boolean): void {
  if (on) {
    attachDebugFileTransport();
    applyLevel('debug');
  } else {
    applyLevel('info');
  }
}

// SIGUSR1: flip verbose mode without restarting. `kill -USR1 <pid>`
// during an incident, then re-send to switch back off. We track our
// own state because `currentLevel` is the source of truth.
process.on('SIGUSR1', () => {
  const next = currentLevel === 'debug' ? 'info' : 'debug';
  setDebugVerbose(next === 'debug');
  logger.info(`[logger] SIGUSR1 — verbose logging now ${next === 'debug' ? 'ON' : 'OFF'}`);
});

const startTimes: Record<string, number> = {};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
logger.time = (key: string, message?: string, ...meta: any[]) => {
  startTimes[key] = performance.now();
  if (message) {
    logger.info(message, ...meta);
  }
};

logger.timeEnd = (key: string, message?: string, ...meta: unknown[]) => {
  const endTime = performance.now();
  const startTime = startTimes[key];

  if (!startTime) return;

  const duration = (endTime - startTime).toFixed(3);

  let newMsg = `[${key}] ${duration} ms`;

  if (message) {
    newMsg = `${message} (${duration} ms)`;
  }

  logger.info(newMsg, ...meta);

  delete startTimes[key];
};

export { logger };
