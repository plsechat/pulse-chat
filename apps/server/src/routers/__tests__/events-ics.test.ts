import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { insertOtherServer } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { servers, users } from '../../db/schema';
import { buildCalendarPath, clearCalendarCache } from '../../http/events-ics';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const roles = [{ key: 'flex', label: 'Flex', cap: null, color: null }];

const draft = (title: string, startsAt: number, extra: Record<string, unknown> = {}) => ({
  title,
  startsAt,
  endsAt: startsAt + HOUR_MS,
  roles,
  ...extra
});

const publicIds = async () => {
  const tdb = getTestDb();
  const [server] = await tdb.select({ publicId: servers.publicId }).from(servers).where(eq(servers.id, 1));
  const [user] = await tdb.select({ publicId: users.publicId }).from(users).where(eq(users.id, 1));
  return { server: server!.publicId, user: user!.publicId };
};

const fetchFeed = (path: string) => fetch(`${testsBaseUrl}${path}`);

describe('calendar feed', () => {
  test('getCalendarUrl hands the caller a signed, personal path', async () => {
    const { caller } = await initTest(1);
    const ids = await publicIds();

    const { path, url } = await caller.events.getCalendarUrl();
    expect(path).toBe(buildCalendarPath(ids.server, ids.user));
    expect(path).toMatch(
      new RegExp(`^/events/${ids.server}\\.ics\\?u=${ids.user}&token=[0-9a-f]{64}$`)
    );
    expect(url.endsWith(path)).toBe(true);

    // A different member gets a different token for the same server.
    const { caller: member } = await initTest(2);
    const other = await member.events.getCalendarUrl();
    expect(other.path).not.toBe(path);
  });

  test('serves VCALENDAR with one VEVENT per non-cancelled event in the window', async () => {
    const { caller } = await initTest(1);
    const ids = await publicIds();
    const now = Date.now();
    clearCalendarCache();

    const soon = await caller.events.create(
      draft('Raid night', now + 2 * HOUR_MS, {
        description: 'Bring flasks;\npotions, food',
        gameTag: 'MMO'
      })
    );
    const cancelled = await caller.events.create(draft('Cancelled one', now + 3 * HOUR_MS));
    await caller.events.cancel({ eventId: cancelled.id });
    await caller.events.create(draft('Too far', now + 95 * DAY_MS));

    const { path } = await caller.events.getCalendarUrl();
    const res = await fetchFeed(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('private, max-age=60');

    const body = await res.text();
    expect(body.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(body.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(body.split('BEGIN:VEVENT')).toHaveLength(2);
    expect(body).toContain(`UID:${ids.server}-${soon.id}@pulse`);
    expect(body).toContain('SUMMARY:Raid night');
    expect(body).toContain('DESCRIPTION:Bring flasks\\;\\npotions\\, food');
    expect(body).toContain('CATEGORIES:MMO');
    expect(body).not.toContain('Cancelled one');
    expect(body).not.toContain('Too far');
    expect(body).not.toContain('URL:');

    const start = new Date(soon.startsAt);
    const stamp = `${start.getUTCFullYear()}${String(start.getUTCMonth() + 1).padStart(2, '0')}${String(
      start.getUTCDate()
    ).padStart(2, '0')}T${String(start.getUTCHours()).padStart(2, '0')}${String(
      start.getUTCMinutes()
    ).padStart(2, '0')}${String(start.getUTCSeconds()).padStart(2, '0')}Z`;
    expect(body).toContain(`DTSTART:${stamp}`);

    for (const line of body.split('\r\n')) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }
  });

  test('folds long lines at 75 octets without splitting a character', async () => {
    const { caller } = await initTest(1);
    clearCalendarCache();
    const description = 'Ünïcödé raid '.repeat(12).trim();
    await caller.events.create(draft('Folded', Date.now() + HOUR_MS, { description }));

    const { path } = await caller.events.getCalendarUrl();
    const body = await (await fetchFeed(path)).text();
    const lines = body.split('\r\n');

    for (const line of lines) {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    }

    // Unfolding (RFC 5545 §3.1) gives the text back intact.
    const unfolded = body.replace(/\r\n /g, '');
    expect(unfolded).toContain(`DESCRIPTION:${description}`);
  });

  test('refuses a missing, malformed or tampered token and an unknown or non-member subscriber', async () => {
    const { caller } = await initTest(1);
    const ids = await publicIds();
    const { path } = await caller.events.getCalendarUrl();
    const token = path.split('token=')[1]!;

    expect((await fetchFeed(`/events/${ids.server}.ics`)).status).toBe(403);
    expect((await fetchFeed(`/events/${ids.server}.ics?u=${ids.user}`)).status).toBe(403);
    expect((await fetchFeed(`/events/${ids.server}.ics?u=${ids.user}&token=abc`)).status).toBe(403);
    const flipped = (token[0] === 'a' ? 'b' : 'a') + token.slice(1);
    expect(
      (await fetchFeed(`/events/${ids.server}.ics?u=${ids.user}&token=${flipped}`)).status
    ).toBe(403);
    // A valid token for one subscriber does not open another's feed.
    const { path: otherPath } = await (await initTest(2)).caller.events.getCalendarUrl();
    const otherUser = otherPath.split('u=')[1]!.split('&')[0]!;
    expect(
      (await fetchFeed(`/events/${ids.server}.ics?u=${otherUser}&token=${token}`)).status
    ).toBe(403);

    expect((await fetchFeed(`/events/nope.ics?u=${ids.user}&token=${token}`)).status).toBe(404);
    expect((await fetchFeed(`/events/${ids.server}.txt?u=${ids.user}&token=${token}`)).status).toBe(404);

    // A correctly signed link for a server the subscriber is not in.
    const other = await insertOtherServer();
    const foreign = buildCalendarPath(other.publicId, ids.user);
    expect((await fetchFeed(foreign)).status).toBe(404);
  });

  test('a render is cached per server for a minute', async () => {
    const { caller } = await initTest(1);
    clearCalendarCache();
    await caller.events.create(draft('First', Date.now() + HOUR_MS));
    const { path } = await caller.events.getCalendarUrl();

    const first = await (await fetchFeed(path)).text();
    expect(first).toContain('SUMMARY:First');

    await caller.events.create(draft('Second', Date.now() + 2 * HOUR_MS));
    const cached = await (await fetchFeed(path)).text();
    expect(cached).toBe(first);

    clearCalendarCache();
    const fresh = await (await fetchFeed(path)).text();
    expect(fresh).toContain('SUMMARY:Second');
  });
});
