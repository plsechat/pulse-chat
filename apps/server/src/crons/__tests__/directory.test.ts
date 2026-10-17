/**
 * directory crons — the daily full pull replaces a peer's cached
 * listing (bounded, delisted rows pruned, silent peers aged out), the
 * hourly counts pass refreshes what is cached, and rows go with the
 * peer on block/remove.
 *
 * The peer is answered by a fetch stub that signs its reply with the
 * seeded peer key, so `queryInstance`'s verification is exercised.
 * Setup is inline per test (no beforeEach — it deadlocks against the
 * global TRUNCATE).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { JWK } from 'jose';
import { config } from '../../config';
import {
  mockDns,
  PEER_DOMAIN,
  seedPeer,
  spyOnFetch,
  TEST_LOCAL_DOMAIN
} from '../../__tests__/federation-fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { directoryCache, federationInstances } from '../../db/schema';
import { _signChallengeAs } from '../../utils/federation';
import { directoryTick } from '../directory';

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  mock.restore();
});

const signedListing = async (servers: unknown[], jwk: JWK): Promise<Response> => {
  const bodyToSign = { servers, fromDomain: PEER_DOMAIN };
  const signature = await _signChallengeAs(bodyToSign, PEER_DOMAIN, TEST_LOCAL_DOMAIN, jwk);
  return new Response(JSON.stringify({ ...bodyToSign, signature }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
};

/** Stub the peer: answer /federation/directory with a signed listing. */
const answerDirectory = (servers: unknown[], jwk: JWK) => {
  mockDns();
  return spyOnFetch((call) =>
    call.url === `https://${PEER_DOMAIN}/federation/directory`
      ? signedListing(servers, jwk)
      : new Response('nope', { status: 404 })
  );
};

const cached = (instanceId: number) =>
  getTestDb()
    .select()
    .from(directoryCache)
    .where(eq(directoryCache.instanceId, instanceId))
    .orderBy(directoryCache.serverPublicId);

const seedCached = (
  instanceId: number,
  serverPublicId: string,
  fetchedAt: number,
  counts = { memberCount: 1, onlineCount: 0 }
) =>
  getTestDb().insert(directoryCache).values({
    instanceId,
    serverPublicId,
    name: serverPublicId,
    tags: [],
    ...counts,
    fetchedAt
  });

const withFederation = async (fn: () => Promise<void>) => {
  const before = config.federation.enabled;
  config.federation.enabled = true;
  try {
    await fn();
  } finally {
    config.federation.enabled = before;
  }
};

describe('directory cron — full pull', () => {
  test('caches the peer\'s listing bounded field by field and drops what it delisted', async () =>
    withFederation(async () => {
      await initTest();
      const { peerInstanceId, peerPrivateJwk } = await seedPeer();
      const now = Date.now();
      await seedCached(peerInstanceId, 'gone', now - DAY_MS);

      const { calls } = answerDirectory(
        [
          {
            publicId: 'club',
            name: 'Chess Club',
            description: 'd'.repeat(500),
            tags: ['casual', 'ranked'],
            game: 'g'.repeat(100),
            memberCount: 42,
            onlineCount: 7,
            logo: 'club.png',
            hasPassword: true
          },
          // Structural problems: skipped, not stored half-empty.
          { name: 'No id' },
          { publicId: 'blank', name: '   ' },
          { publicId: 'club', name: 'Duplicate of club' },
          // Field problems: the field is dropped, the row kept.
          {
            publicId: 'odd',
            name: 'Odd Fields',
            tags: ['a', 'b', 'c', 'd', 'e', 'f'],
            memberCount: -1,
            onlineCount: 2.5,
            logo: '../../etc/passwd'
          },
          { publicId: 'minimal', name: 'x'.repeat(200) }
        ],
        peerPrivateJwk
      );

      const summary = await directoryTick('full', now);

      expect(summary).toEqual({ peers: 1, failed: 0, rows: 3, removed: 1, stale: 0 });
      const request = calls.find((c) => c.url.endsWith('/federation/directory'));
      expect(request?.method).toBe('POST');
      expect(request?.body.limit).toBe(200);
      expect(typeof request?.body.signature).toBe('string');

      const rows = await cached(peerInstanceId);
      expect(rows.map((r) => r.serverPublicId)).toEqual(['club', 'minimal', 'odd']);
      const club = rows[0]!;
      expect(club.name).toBe('Chess Club');
      expect(club.description).toHaveLength(300);
      expect(club.game).toHaveLength(60);
      expect(club.tags).toEqual(['casual', 'ranked']);
      expect(club.memberCount).toBe(42);
      expect(club.onlineCount).toBe(7);
      expect(club.logoUrl).toBe(`https://${PEER_DOMAIN}/public/club.png`);
      expect(club.hasPassword).toBe(true);
      expect(club.fetchedAt).toBe(now);
      const odd = rows[2]!;
      expect(odd.tags).toEqual([]);
      expect(odd.memberCount).toBe(0);
      expect(odd.onlineCount).toBe(0);
      expect(odd.logoUrl).toBeNull();
      expect(odd.hasPassword).toBe(false);
      expect(rows[1]!.name).toHaveLength(100);
    }));

  test('more than 200 rows are cut; a second pull replaces the set in place', async () =>
    withFederation(async () => {
      await initTest();
      const { peerInstanceId, peerPrivateJwk } = await seedPeer();

      answerDirectory(
        Array.from({ length: 250 }, (_, i) => ({ publicId: `s${i}`, name: `Server ${i}` })),
        peerPrivateJwk
      );
      await directoryTick('full', Date.now());
      expect(await cached(peerInstanceId)).toHaveLength(200);

      mock.restore();
      answerDirectory([{ publicId: 's0', name: 'Server 0 renamed' }], peerPrivateJwk);
      const summary = await directoryTick('full', Date.now());
      expect(summary.removed).toBe(199);
      const rows = await cached(peerInstanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe('Server 0 renamed');
    }));

  test('an unreachable or unverifiable peer keeps its cache; rows a week stale are aged out', async () =>
    withFederation(async () => {
      await initTest();
      const { peerInstanceId } = await seedPeer();
      const now = Date.now();
      await seedCached(peerInstanceId, 'fresh', now - DAY_MS);
      await seedCached(peerInstanceId, 'stale', now - 8 * DAY_MS);
      mockDns();
      spyOnFetch(() => new Response('', { status: 503 }));

      let summary = await directoryTick('full', now);
      expect(summary).toEqual({ peers: 1, failed: 1, rows: 0, removed: 0, stale: 1 });
      expect((await cached(peerInstanceId)).map((r) => r.serverPublicId)).toEqual(['fresh']);

      // An unsigned 200 is as good as unreachable.
      mock.restore();
      mockDns();
      spyOnFetch(
        () =>
          new Response(JSON.stringify({ servers: [{ publicId: 'x', name: 'Forged' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          })
      );
      summary = await directoryTick('full', now);
      expect(summary.failed).toBe(1);
      expect((await cached(peerInstanceId)).map((r) => r.serverPublicId)).toEqual(['fresh']);
    }));

  test('is a no-op while federation is off', async () => {
    await initTest();
    const { peerInstanceId } = await seedPeer();
    await seedCached(peerInstanceId, 'stale', Date.now() - 30 * DAY_MS);
    const before = config.federation.enabled;
    config.federation.enabled = false;
    try {
      const { calls } = spyOnFetch();
      expect(await directoryTick('full')).toEqual({ peers: 0, failed: 0, rows: 0, removed: 0, stale: 0 });
      expect(calls).toHaveLength(0);
      expect(await cached(peerInstanceId)).toHaveLength(1);
    } finally {
      config.federation.enabled = before;
    }
  });
});

describe('directory cron — hourly counts', () => {
  test('refreshes counts of cached rows, drops delisted ones, adds nothing and keeps fetchedAt', async () =>
    withFederation(async () => {
      await initTest();
      const { peerInstanceId, peerPrivateJwk } = await seedPeer();
      const pulledAt = Date.now() - 6 * 60 * 60 * 1000;
      await seedCached(peerInstanceId, 'club', pulledAt, { memberCount: 10, onlineCount: 1 });
      await seedCached(peerInstanceId, 'delisted', pulledAt);

      answerDirectory(
        [
          { publicId: 'club', name: 'Renamed Club', memberCount: 12, onlineCount: 4 },
          { publicId: 'brand-new', name: 'Brand New', memberCount: 1 }
        ],
        peerPrivateJwk
      );

      const summary = await directoryTick('counts', Date.now());

      expect(summary).toEqual({ peers: 1, failed: 0, rows: 1, removed: 1, stale: 0 });
      const rows = await cached(peerInstanceId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        serverPublicId: 'club',
        // The counts pass does not rewrite the card copy …
        name: 'club',
        memberCount: 12,
        onlineCount: 4,
        // … nor the staleness stamp.
        fetchedAt: pulledAt
      });
    }));
});

describe('directory cache lifecycle', () => {
  test('rows go when the peer is blocked, removed, or ends the pairing', async () =>
    withFederation(async () => {
      const { caller } = await initTest(1);
      const { peerInstanceId } = await seedPeer();
      const { peerInstanceId: secondId } = await seedPeer('second.example');
      await seedCached(peerInstanceId, 'a', Date.now());
      await seedCached(secondId, 'b', Date.now());
      mockDns();
      spyOnFetch();

      await caller.federation.blockInstance({ instanceId: peerInstanceId });
      expect(await cached(peerInstanceId)).toHaveLength(0);
      expect(await cached(secondId)).toHaveLength(1);
      const [blockedRow] = await getTestDb()
        .select({ status: federationInstances.status })
        .from(federationInstances)
        .where(eq(federationInstances.id, peerInstanceId));
      expect(blockedRow?.status).toBe('blocked');

      await caller.federation.removeInstance({ instanceId: secondId });
      expect(await cached(secondId)).toHaveLength(0);
    }));
});
