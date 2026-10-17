import crypto from 'crypto';
import http from 'http';
import { eq } from 'drizzle-orm';
import type { TEvent } from '../types';
import { db } from '../db';
import { listFeedEvents } from '../db/queries/events';
import { getFileHmacSecretSync } from '../db/queries/server';
import { isServerMember } from '../db/queries/servers';
import { servers, users } from '../db/schema';
import { sanitizeForLog } from '../helpers/sanitize-for-log';
import { logger } from '../logger';

/**
 * `GET /events/<serverPublicId>.ics?u=<userPublicId>&token=<hmac>`
 *
 * A calendar app polls this with no session, so the URL itself is the
 * credential: the token is an HMAC over the server and the subscriber,
 * keyed with the same per-instance secret that signs attachment URLs
 * (files-crypto). The subscriber's public id travels in `u` so the
 * handler can recompute the signature; the token binds the two, so a
 * link only ever opens the calendar its owner could read, and it dies
 * with their membership. The feed has no per-event URL and no ids a
 * client could act on.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far ahead a feed looks. */
const FEED_WINDOW_MS = 90 * DAY_MS;
/** A raid that ended earlier today still shows; older ones drop off. */
const FEED_LOOKBACK_MS = DAY_MS;
/** One render per server per minute, whatever the number of subscribers polling. */
const CACHE_TTL_MS = 60_000;
/** Bound on cached renders: the LRU-ish eviction below drops the oldest. */
const CACHE_MAX_ENTRIES = 256;
/** Public ids are UUIDv7 (36 chars); test fixtures prefix them, so a little headroom. */
const PUBLIC_ID_MAX = 128;
/** Hex SHA-256. */
const TOKEN_LENGTH = 64;
/** RFC 5545 §3.1: content lines are at most 75 octets before folding. */
const ICS_LINE_OCTETS = 75;

const EVENTS_ICS_PATH = /^\/events\/([^/]{1,128})\.ics$/;

const signCalendarToken = (serverPublicId: string, userPublicId: string) =>
  crypto
    .createHmac('sha256', getFileHmacSecretSync())
    .update(`calendar:${serverPublicId}:${userPublicId}`)
    .digest('hex');

const buildCalendarPath = (serverPublicId: string, userPublicId: string) =>
  `/events/${encodeURIComponent(serverPublicId)}.ics?u=${encodeURIComponent(
    userPublicId
  )}&token=${signCalendarToken(serverPublicId, userPublicId)}`;

const verifyCalendarToken = (
  serverPublicId: string,
  userPublicId: string,
  token: string
): boolean => {
  if (token.length !== TOKEN_LENGTH) return false;

  const expected = signCalendarToken(serverPublicId, userPublicId);

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
};

// ─── rendering ────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

const icsDate = (ms: number) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(
    d.getUTCHours()
  )}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};

/** Control characters other than CR/LF have no place in a content line. */
const stripControl = (value: string) =>
  Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f);
    })
    .join('');

/** RFC 5545 §3.3.11 TEXT escaping. */
const icsText = (value: string) =>
  stripControl(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');

/** Fold one content line at 75 octets (not characters: a multi-byte char never straddles a fold). */
const foldLine = (line: string): string[] => {
  const out: string[] = [];
  let current = '';
  let octets = 0;

  for (const char of line) {
    const size = Buffer.byteLength(char);
    // Continuation lines start with a space, which counts toward the 75.
    const limit = out.length === 0 ? ICS_LINE_OCTETS : ICS_LINE_OCTETS - 1;

    if (octets + size > limit) {
      out.push(current);
      current = char;
      octets = size;
    } else {
      current += char;
      octets += size;
    }
  }

  out.push(current);

  return out.map((part, index) => (index === 0 ? part : ` ${part}`));
};

const renderCalendar = (
  server: { publicId: string; name: string },
  rows: TEvent[],
  now: number
): string => {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pulse//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(server.name)}`
  ];

  for (const event of rows) {
    lines.push(
      'BEGIN:VEVENT',
      // events have no public id of their own: the server's public id
      // plus the row id is globally unique and stable across renders.
      `UID:${server.publicId}-${event.id}@pulse`,
      `DTSTAMP:${icsDate(now)}`,
      `DTSTART:${icsDate(event.startsAt)}`,
      `DTEND:${icsDate(event.endsAt)}`,
      `SUMMARY:${icsText(event.title)}`
    );

    if (event.description) {
      lines.push(`DESCRIPTION:${icsText(event.description)}`);
    }

    if (event.gameTag) {
      lines.push(`CATEGORIES:${icsText(event.gameTag)}`);
    }

    lines.push(`STATUS:CONFIRMED`, `LAST-MODIFIED:${icsDate(event.updatedAt)}`, 'END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.flatMap(foldLine).join('\r\n') + '\r\n';
};

// ─── cache ────────────────────────────────────────────────────────────

const cache = new Map<number, { body: string; renderedAt: number }>();

const cachedCalendar = async (
  server: { id: number; publicId: string; name: string },
  now: number
): Promise<string> => {
  const hit = cache.get(server.id);

  if (hit && now - hit.renderedAt < CACHE_TTL_MS) return hit.body;

  const rows = await listFeedEvents(
    server.id,
    now - FEED_LOOKBACK_MS,
    now + FEED_WINDOW_MS
  );
  const body = renderCalendar(server, rows, now);

  // Map iteration is insertion-ordered: delete + set keeps the most
  // recently rendered server at the end, so the first key is the stalest.
  cache.delete(server.id);
  cache.set(server.id, { body, renderedAt: now });

  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }

  return body;
};

/** Test hook: a render is cached per server for CACHE_TTL_MS. */
const clearCalendarCache = () => cache.clear();

// ─── handler ──────────────────────────────────────────────────────────

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const eventsIcsRouteHandler = async (
  req: http.IncomingMessage,
  res: http.ServerResponse
) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = EVENTS_ICS_PATH.exec(url.pathname);

  if (!match) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const serverPublicId = decodeURIComponent(match[1]!);
  const userPublicId = url.searchParams.get('u') ?? '';
  const token = url.searchParams.get('token') ?? '';

  if (
    serverPublicId.length > PUBLIC_ID_MAX ||
    userPublicId.length === 0 ||
    userPublicId.length > PUBLIC_ID_MAX ||
    token.length !== TOKEN_LENGTH
  ) {
    return sendJson(res, 403, { error: 'Invalid calendar token' });
  }

  const [[server], [user]] = await Promise.all([
    db
      .select({ id: servers.id, publicId: servers.publicId, name: servers.name })
      .from(servers)
      .where(eq(servers.publicId, serverPublicId))
      .limit(1),
    db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.publicId, userPublicId))
      .limit(1)
  ]);

  if (!server || !user) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  if (!verifyCalendarToken(serverPublicId, userPublicId, token)) {
    logger.debug(
      '[events-ics] bad token for server %s',
      sanitizeForLog(serverPublicId)
    );
    return sendJson(res, 403, { error: 'Invalid calendar token' });
  }

  // A link outlives its owner's membership only until the next poll.
  if (!(await isServerMember(server.id, user.id))) {
    return sendJson(res, 404, { error: 'Not found' });
  }

  const body = await cachedCalendar(server, Date.now());

  res.writeHead(200, {
    'Content-Type': 'text/calendar; charset=utf-8',
    'Cache-Control': 'private, max-age=60',
    'Content-Disposition': 'inline; filename="events.ics"'
  });
  res.end(body);
};

export {
  buildCalendarPath,
  clearCalendarCache,
  eventsIcsRouteHandler,
  signCalendarToken
};
