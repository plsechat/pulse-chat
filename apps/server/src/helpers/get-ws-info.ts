import type http from 'http';
import net from 'net';
import type { WebSocket } from 'ws';
import { UAParser } from 'ua-parser-js';

/** What a login/session records about the connecting client. */
export type TConnectionInfo = {
  ip?: string;
  os?: string;
  device?: string;
  userAgent?: string;
};

type WsWithInternals = WebSocket & {
  _socket?: { remoteAddress?: string };
  socket?: { remoteAddress?: string };
};

type THeaderValue = string | string[] | undefined;

/**
 * The subset of `http.IncomingMessage` the client-address helpers read.
 * Structural so callers can pass a real request, a WebSocket upgrade
 * request or a hand-built object in tests.
 */
type TRequestLike = {
  headers: Record<string, THeaderValue> | http.IncomingHttpHeaders;
  socket?: { remoteAddress?: string; encrypted?: boolean } | null;
};

type TPublicOrigin = { proto: 'http' | 'https'; host: string };

// Read per call (not at module load) so a deployment that sets the flag
// late and the unit tests that toggle it both see the live value.
const isTrustedProxy = (): boolean => process.env.TRUST_PROXY === 'true';

const headerString = (value: THeaderValue): string | undefined => {
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' ? value : undefined;
};

/**
 * Canonicalise an address the way the rest of the server keys on it:
 * strip IPv4-mapped IPv6 and URL brackets, fold `::1` to `127.0.0.1`.
 * Returns undefined for anything that is not a syntactically valid IP
 * (header garbage, `__proto__`, a 16 KB string...).
 */
const normalizeIp = (raw: string | undefined): string | undefined => {
  if (!raw) return undefined;

  let ip = raw.trim();

  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1') ip = '127.0.0.1';

  return net.isIP(ip) ? ip : undefined;
};

/**
 * Trusted-proxy client address. Honoured only when `TRUST_PROXY=true`.
 *
 * Default source is the RIGHTMOST `X-Forwarded-For` hop: every reverse
 * proxy APPENDS to that header (`$proxy_add_x_forwarded_for` and friends),
 * so the last entry is the one the trusted proxy itself wrote and the
 * leftmost ones are client-chosen. `cf-connecting-ip` / `x-real-ip` are
 * only trusted when `TRUST_PROXY_HEADER` names one of them: a proxy that
 * does not OVERWRITE such a header passes a client-supplied value through
 * untouched, which would reopen the spoof this helper closes.
 */
const OVERRIDE_IP_HEADERS = new Set(['cf-connecting-ip', 'x-real-ip']);

const trustedOverrideHeader = (): string | undefined => {
  const name = process.env.TRUST_PROXY_HEADER?.trim().toLowerCase();
  return name && OVERRIDE_IP_HEADERS.has(name) ? name : undefined;
};

const proxyClientIp = (headers: TRequestLike['headers']): string | undefined => {
  const override = trustedOverrideHeader();
  if (override) {
    const direct = normalizeIp(headerString(headers[override]));
    if (direct) return direct;
  }

  const forwardedFor = headerString(headers['x-forwarded-for']);
  if (!forwardedFor) return undefined;

  const hops = forwardedFor.split(',');
  return normalizeIp(hops[hops.length - 1]);
};

const resolveClientIp = (
  req: TRequestLike | undefined,
  ws?: WsWithInternals
): string | undefined => {
  const headers = req?.headers ?? {};

  if (isTrustedProxy()) {
    const fromProxy = proxyClientIp(headers);
    if (fromProxy) return fromProxy;
  }

  return (
    normalizeIp(req?.socket?.remoteAddress) ??
    normalizeIp(ws?._socket?.remoteAddress) ??
    normalizeIp(ws?.socket?.remoteAddress)
  );
};

/**
 * The address every per-client decision keys on (rate limits, socket
 * caps, login records). Always a validated IP literal; `unknown` when
 * nothing usable is present (a socket that already went away).
 */
const getClientIp = (req: TRequestLike): string =>
  resolveClientIp(req) ?? 'unknown';

// RFC 3986 reg-name / IPv4 host with an optional port, or a bracketed
// IPv6 literal with an optional port. Rejects header values that would
// turn a derived redirect/cookie host into something else entirely.
const HOST_PATTERN =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

const validHost = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const host = value.trim();
  return host.length <= 255 && HOST_PATTERN.test(host) ? host : undefined;
};

const validProto = (value: string | undefined): 'http' | 'https' | undefined => {
  const proto = value?.trim().toLowerCase();
  return proto === 'http' || proto === 'https' ? proto : undefined;
};

const publicUrlOrigin = (): TPublicOrigin | undefined => {
  const raw = process.env.PUBLIC_URL?.trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const proto = validProto(url.protocol.replace(/:$/, ''));
    const host = validHost(url.host);
    return proto && host ? { proto, host } : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The scheme and host clients reach this instance on. Precedence:
 * `PUBLIC_URL` (operator-declared, wins outright) → trusted-proxy
 * `x-forwarded-proto` / `x-forwarded-host` (validated, last hop) →
 * the request's own `Host` and `http` (or `https` when the socket
 * itself is TLS). Drives HSTS, OIDC redirect URIs and cookie flags.
 */
const resolvePublicOrigin = (req: TRequestLike): TPublicOrigin => {
  const declared = publicUrlOrigin();
  if (declared) return declared;

  const headers = req.headers;
  const requestHost = validHost(headerString(headers.host)) ?? 'localhost';
  const socketProto: 'http' | 'https' = req.socket?.encrypted ? 'https' : 'http';

  if (!isTrustedProxy()) {
    return { proto: socketProto, host: requestHost };
  }

  const protoHops = headerString(headers['x-forwarded-proto'])?.split(',');
  const forwardedProto = validProto(protoHops?.[protoHops.length - 1]);
  const hostHops = headerString(headers['x-forwarded-host'])?.split(',');
  const forwardedHost = validHost(hostHops?.[hostHops.length - 1]);

  return {
    proto: forwardedProto ?? socketProto,
    host: forwardedHost ?? requestHost
  };
};

const getWsInfo = (
  ws: WsWithInternals | undefined,
  req: http.IncomingMessage
): TConnectionInfo | undefined => {
  const ip = resolveClientIp(req, ws);
  const userAgent = req?.headers?.['user-agent'];

  if (!ip && !userAgent) return undefined;

  const parser = new UAParser(userAgent || '');
  const result = parser.getResult();

  return {
    ip,
    os: result.os.name
      ? [result.os.name, result.os.version].filter(Boolean).join(' ')
      : undefined,
    device: result.device.type
      ? [result.device.vendor, result.device.model]
          .filter(Boolean)
          .join(' ')
          .trim()
      : 'Desktop',
    userAgent: userAgent || undefined
  };
};

export { getClientIp, getWsInfo, resolvePublicOrigin };
export type { TPublicOrigin, TRequestLike };
