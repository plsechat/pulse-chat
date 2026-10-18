/**
 * Optional TURN relay configuration for clients that cannot reach the
 * media port directly (UDP and TCP to it both blocked). mediasoup is
 * ICE-lite behind an announced address, so the SERVER never needs a
 * relay and STUN is pointless; only such clients do. The operator points
 * at a relay they control and the values are handed to clients via
 * /info as RTCIceServer entries.
 *
 * Kept free of config/logger imports so config.ts can use it at module
 * evaluation time (logger → config is a cycle) and tests can exercise
 * the parser without the mocked config module.
 */

import type { TIceServer, TIceTransportPolicy } from '@pulse/shared';

type TWebrtcIceConfig = {
  turn: {
    urls: string[];
    username: string;
    credential: string;
  };
  iceTransportPolicy: TIceTransportPolicy;
};

// Bounds: a relay list is a handful of entries, and each URL is a short
// `turn(s):host:port?transport=…` string. Anything beyond is a typo or
// an injection attempt into every client's RTCPeerConnection config.
const MAX_TURN_URLS = 8;
const MAX_TURN_URL_LENGTH = 256;
const MAX_TURN_CREDENTIAL_LENGTH = 512;

// RFC 7064 / RFC 7065 schemes. STUN entries are accepted so an operator
// can list a STUN server alongside the relay if their client population
// needs it, but Pulse itself never requires one.
const ICE_URL_PATTERN = /^(turns?|stuns?):[^\s]+$/i;

const defaultWebrtcIceConfig = (): TWebrtcIceConfig => ({
  turn: { urls: [], username: '', credential: '' },
  iceTransportPolicy: 'all'
});

/** Normalise a comma-separated (or array) URL list to the bounded set. */
const parseTurnUrls = (raw: unknown): string[] => {
  const list = Array.isArray(raw)
    ? raw.map((v) => String(v))
    : typeof raw === 'string'
      ? raw.split(',')
      : [];

  const urls: string[] = [];
  for (const entry of list) {
    const url = entry.trim();
    if (url.length === 0 || url.length > MAX_TURN_URL_LENGTH) continue;
    if (!ICE_URL_PATTERN.test(url)) continue;
    if (urls.includes(url)) continue;
    urls.push(url);
    if (urls.length >= MAX_TURN_URLS) break;
  }
  return urls;
};

const parseCredential = (raw: unknown): string => {
  if (typeof raw !== 'string') return '';
  const value = raw.trim();
  return value.length > MAX_TURN_CREDENTIAL_LENGTH ? '' : value;
};

const parseIceTransportPolicy = (raw: unknown): TIceTransportPolicy | undefined => {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  return value === 'all' || value === 'relay' ? value : undefined;
};

/**
 * Overlay env values on a base config. Each variable only applies when
 * present, so an operator can keep URLs in config.ini and inject the
 * credential from the environment (or override everything per
 * deployment). An unparsable value leaves the base untouched.
 */
const applyWebrtcIceEnv = (
  base: TWebrtcIceConfig,
  env: Record<string, string | undefined>
): TWebrtcIceConfig => {
  const next: TWebrtcIceConfig = {
    turn: { ...base.turn, urls: [...base.turn.urls] },
    iceTransportPolicy: base.iceTransportPolicy
  };

  if (env.WEBRTC_TURN_URLS !== undefined) {
    next.turn.urls = parseTurnUrls(env.WEBRTC_TURN_URLS);
  }
  if (env.WEBRTC_TURN_USERNAME !== undefined) {
    next.turn.username = parseCredential(env.WEBRTC_TURN_USERNAME);
  }
  if (env.WEBRTC_TURN_CREDENTIAL !== undefined) {
    next.turn.credential = parseCredential(env.WEBRTC_TURN_CREDENTIAL);
  }
  const policy = parseIceTransportPolicy(env.WEBRTC_ICE_TRANSPORT_POLICY);
  if (policy) next.iceTransportPolicy = policy;

  return next;
};

/** Normalise whatever the INI parser produced into the bounded shape. */
const normaliseWebrtcIceConfig = (raw: unknown): TWebrtcIceConfig => {
  const next = defaultWebrtcIceConfig();
  if (!raw || typeof raw !== 'object') return next;

  const section = raw as { turn?: unknown; iceTransportPolicy?: unknown };
  if (section.turn && typeof section.turn === 'object') {
    const turn = section.turn as Record<string, unknown>;
    next.turn.urls = parseTurnUrls(turn.urls);
    next.turn.username = parseCredential(turn.username);
    next.turn.credential = parseCredential(turn.credential);
  }
  next.iceTransportPolicy =
    parseIceTransportPolicy(section.iceTransportPolicy) ?? 'all';
  return next;
};

/**
 * The RTCIceServer list clients should use, or undefined when no relay
 * is configured (the client then builds transports with no iceServers,
 * exactly as before). The credential is included on purpose: it is
 * per-instance config every client needs; operators should issue
 * time-limited TURN credentials or run a relay they control.
 */
const buildIceServers = (cfg: TWebrtcIceConfig): TIceServer[] | undefined => {
  if (cfg.turn.urls.length === 0) return undefined;
  const server: TIceServer = { urls: [...cfg.turn.urls] };
  if (cfg.turn.username) server.username = cfg.turn.username;
  if (cfg.turn.credential) server.credential = cfg.turn.credential;
  return [server];
};

export {
  applyWebrtcIceEnv,
  buildIceServers,
  defaultWebrtcIceConfig,
  normaliseWebrtcIceConfig,
  type TWebrtcIceConfig
};
