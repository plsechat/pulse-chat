import { parse, stringify } from 'ini';
import fs from 'node:fs/promises';
import { ensureServerDirs } from './helpers/ensure-server-dirs';
import { getPrivateIp, getPublicIp } from './helpers/network';
import { CONFIG_INI_PATH } from './helpers/paths';
import {
  applyWebrtcIceEnv,
  defaultWebrtcIceConfig,
  normaliseWebrtcIceConfig,
  type TWebrtcIceConfig
} from './helpers/webrtc-ice';
import { IS_DEVELOPMENT } from './utils/env';
import { fileExists } from './utils/file-manager';

const [SERVER_PUBLIC_IP, SERVER_PRIVATE_IP] = await Promise.all([
  getPublicIp(),
  getPrivateIp()
]);

type TMediasoupMode = 'single-port' | 'range';

type TConfig = {
  server: {
    port: number;
    debug: boolean;
    debugLogMaxSizeMb: number;
    debugLogMaxFiles: number;
    debugLogIncludeBody: boolean;
    redactExtra: string[];
    // Days to keep `logins` and `activity_log` rows (both hold PII and grow
    // with every request). The daily retention cron deletes older rows;
    // 0 disables pruning.
    retentionDays: number;
  };
  mediasoup: {
    worker: {
      // 'single-port' (default): one WebRtcServer binds `port` for UDP
      // and TCP and every transport multiplexes over it — one firewall
      // rule, no participant ceiling from ports. 'range': each transport
      // binds its own UDP and TCP port from rtcMinPort–rtcMaxPort (the
      // pre-WebRtcServer behaviour, kept for operators whose network
      // depends on it; capacity ≈ range size / 2 participants).
      mode: TMediasoupMode;
      port: number;
      rtcMinPort: number;
      rtcMaxPort: number;
    };
    // Instance-wide cap on concurrent voice participants across every
    // channel and DM call; 0 = unlimited. Mediasoup runs on one worker,
    // so this is the operator's CPU/bandwidth guard.
    maxParticipants: number;
    audio: {
      maxBitrate: number;
      stereo: boolean;
      fec: boolean;
      dtx: boolean;
    };
    video: {
      initialAvailableOutgoingBitrate: number;
    };
  };
  webrtc: TWebrtcIceConfig;
  federation: {
    enabled: boolean;
    domain: string;
    // When false (default), only the instance owner may mark a server
    // federatable. When true, any server owner may make their own server
    // federatable. Instance-owner-controlled; see federation/set-config.
    allowUserFederatableServers: boolean;
  };
};

let config: TConfig = {
  server: {
    port: 5443,
    debug: IS_DEVELOPMENT ? true : false,
    debugLogMaxSizeMb: 200,
    debugLogMaxFiles: 10,
    debugLogIncludeBody: true,
    redactExtra: [],
    retentionDays: 90
  },
  mediasoup: {
    worker: {
      mode: 'single-port',
      port: 40000,
      rtcMinPort: 40000,
      rtcMaxPort: 40020
    },
    maxParticipants: 0,
    audio: {
      maxBitrate: 510000,
      stereo: true,
      fec: true,
      dtx: true
    },
    video: {
      initialAvailableOutgoingBitrate: 6000000
    }
  },
  webrtc: defaultWebrtcIceConfig(),
  federation: {
    enabled: false,
    domain: '',
    allowUserFederatableServers: false
  }
};

// Runs at module-evaluation time, before the config.ini write below. ESM
// evaluates every import before the body of index.ts runs, so this (not index.ts)
// is what guarantees the data directories exist on a fresh install.
await ensureServerDirs();

if (!(await fileExists(CONFIG_INI_PATH))) {
  await fs.writeFile(CONFIG_INI_PATH, stringify(config));
}

const text = await fs.readFile(CONFIG_INI_PATH, {
  encoding: 'utf-8'
});

const parsed = parse(text) as Record<string, unknown>;

// Deep-merge parsed INI over defaults so new sections (e.g. federation)
// are always present even on existing installs.
config = {
  server: { ...config.server, ...(parsed.server as object) },
  mediasoup: {
    ...config.mediasoup,
    ...(parsed.mediasoup as object),
    worker: {
      ...config.mediasoup.worker,
      ...((parsed.mediasoup as Record<string, object>)?.worker as object)
    },
    audio: {
      ...config.mediasoup.audio,
      ...((parsed.mediasoup as Record<string, object>)?.audio as object)
    },
    video: {
      ...config.mediasoup.video,
      ...((parsed.mediasoup as Record<string, object>)?.video as object)
    }
  },
  webrtc: normaliseWebrtcIceConfig(parsed.webrtc),
  federation: { ...config.federation, ...(parsed.federation as object) }
} as TConfig;

// Coerce INI string values back to proper types
config.server.port = Number(config.server.port);
config.server.debug = String(config.server.debug) === 'true';
// A non-integer or negative value falls back to the default rather than
// silently disabling pruning (0 is the explicit off switch).
const parsedRetentionDays = Number(config.server.retentionDays);
config.server.retentionDays =
  Number.isInteger(parsedRetentionDays) && parsedRetentionDays >= 0
    ? parsedRetentionDays
    : 90;
config.mediasoup.worker.rtcMinPort = Number(config.mediasoup.worker.rtcMinPort);
config.mediasoup.worker.rtcMaxPort = Number(config.mediasoup.worker.rtcMaxPort);
config.mediasoup.worker.port = Number(config.mediasoup.worker.port);
config.mediasoup.worker.mode =
  String(config.mediasoup.worker.mode) === 'range' ? 'range' : 'single-port';
config.mediasoup.maxParticipants = Number(config.mediasoup.maxParticipants);
config.mediasoup.audio.maxBitrate = Number(config.mediasoup.audio.maxBitrate);
config.mediasoup.audio.stereo = String(config.mediasoup.audio.stereo) === 'true';
config.mediasoup.audio.fec = String(config.mediasoup.audio.fec) === 'true';
config.mediasoup.audio.dtx = String(config.mediasoup.audio.dtx) === 'true';
config.mediasoup.video.initialAvailableOutgoingBitrate = Number(config.mediasoup.video.initialAvailableOutgoingBitrate);
config.federation.enabled = String(config.federation.enabled) === 'true';
config.federation.allowUserFederatableServers =
  String(config.federation.allowUserFederatableServers) === 'true';

// Env vars take precedence over the INI file. The INI is operator-
// persisted runtime state; env vars are explicit overrides applied
// per-deployment (Docker, .env, CI). Apply them last so they win.
//
// DEBUG_LOGGING is the canonical flag; DEBUG is kept as a backward-
// compat alias so existing .env files keep working.
if (
  process.env.DEBUG_LOGGING === 'true' ||
  process.env.DEBUG === 'true' ||
  process.env.DEBUG === '1'
) {
  config.server.debug = true;
}

if (process.env.DEBUG_LOG_MAX_SIZE_MB) {
  const parsedMb = Number(process.env.DEBUG_LOG_MAX_SIZE_MB);
  if (Number.isFinite(parsedMb) && parsedMb > 0) {
    config.server.debugLogMaxSizeMb = parsedMb;
  }
}

if (process.env.DEBUG_LOG_MAX_FILES) {
  const parsedFiles = Number(process.env.DEBUG_LOG_MAX_FILES);
  if (Number.isFinite(parsedFiles) && parsedFiles > 0) {
    config.server.debugLogMaxFiles = parsedFiles;
  }
}

if (process.env.DEBUG_LOG_INCLUDE_BODY === 'false') {
  config.server.debugLogIncludeBody = false;
}

if (process.env.REDACT_EXTRA) {
  config.server.redactExtra = process.env.REDACT_EXTRA.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Voice media networking. Docker deployments cannot edit config.ini
// before first boot, so every port/capacity key has an env override.
if (process.env.MEDIASOUP_MODE) {
  const mode = process.env.MEDIASOUP_MODE.trim().toLowerCase();
  if (mode === 'range' || mode === 'single-port') {
    config.mediasoup.worker.mode = mode;
  }
}

const envPort = (name: string): number | undefined => {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 65535
    ? value
    : undefined;
};

config.mediasoup.worker.port =
  envPort('MEDIASOUP_PORT') ?? config.mediasoup.worker.port;
config.mediasoup.worker.rtcMinPort =
  envPort('MEDIASOUP_RTC_MIN_PORT') ?? config.mediasoup.worker.rtcMinPort;
config.mediasoup.worker.rtcMaxPort =
  envPort('MEDIASOUP_RTC_MAX_PORT') ?? config.mediasoup.worker.rtcMaxPort;

if (process.env.MEDIASOUP_MAX_PARTICIPANTS !== undefined) {
  const cap = Number(process.env.MEDIASOUP_MAX_PARTICIPANTS);
  if (Number.isInteger(cap) && cap >= 0) config.mediasoup.maxParticipants = cap;
}

// Invalid values fall back to the defaults rather than handing mediasoup
// a port it cannot bind (an unbindable media port is a dead voice stack
// that only shows up on the first join).
const isPort = (value: number) =>
  Number.isInteger(value) && value >= 1 && value <= 65535;
if (!isPort(config.mediasoup.worker.port)) config.mediasoup.worker.port = 40000;
if (
  !isPort(config.mediasoup.worker.rtcMinPort) ||
  !isPort(config.mediasoup.worker.rtcMaxPort) ||
  config.mediasoup.worker.rtcMinPort > config.mediasoup.worker.rtcMaxPort
) {
  config.mediasoup.worker.rtcMinPort = 40000;
  config.mediasoup.worker.rtcMaxPort = 40020;
}
if (
  !Number.isInteger(config.mediasoup.maxParticipants) ||
  config.mediasoup.maxParticipants < 0
) {
  config.mediasoup.maxParticipants = 0;
}

config.webrtc = applyWebrtcIceEnv(config.webrtc, process.env);

export { config, SERVER_PRIVATE_IP, SERVER_PUBLIC_IP, type TMediasoupMode };
