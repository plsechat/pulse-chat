/**
 * POST /federation/directory — a peer pulls this instance's listed
 * servers. Signed in, signed out, bounded, and silent (an empty list)
 * when the owner has not exposed the directory.
 *
 * Setup is inline per test (no beforeEach — it deadlocks against the
 * global TRUNCATE).
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import {
  PEER_DOMAIN,
  postSignedAsPeer,
  seedPeer,
  TEST_LOCAL_DOMAIN
} from '../../__tests__/federation-fixtures';
import { createTestServer, createTestServerMember, createTestUser } from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { testsBaseUrl } from '../../__tests__/setup';
import { files, servers } from '../../db/schema';

config.federation.enabled = true;
// Not read from a config.ini an earlier run may have left behind.
config.federation.exposeDirectory = true;

afterEach(() => {
  mock.restore();
  config.federation.exposeDirectory = true;
});

type TWireRow = {
  publicId: string;
  name: string;
  description: string | null;
  tags: string[];
  game: string | null;
  memberCount: number;
  onlineCount: number;
  logo: string | null;
  hasPassword: boolean;
};

const offer = async (
  name: string,
  overrides: Partial<typeof servers.$inferInsert> = {}
) => {
  const id = await createTestServer({ name, ownerId: 1 });
  await getTestDb()
    .update(servers)
    .set({
      directoryListed: true,
      federatable: true,
      allowNewUsers: true,
      ...overrides
    })
    .where(eq(servers.id, id));
  return id;
};

describe('POST /federation/directory', () => {
  test('answers a signed listing of listed, federatable, open servers', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const tdb = getTestDb();

    const [logo] = await tdb
      .insert(files)
      .values({
        name: 'club-logo.png',
        originalName: 'logo.png',
        md5: 'd41d8cd98f00b204e9800998ecf8427e',
        extension: 'png',
        mimeType: 'image/png',
        size: 10,
        userId: 1,
        createdAt: Date.now()
      })
      .returning({ id: files.id });

    const club = await offer('Chess Club', {
      directoryDescription: 'Evening games',
      directoryTags: ['casual', 'ranked'],
      directoryGame: 'Chess',
      logoId: logo!.id,
      password: 'secret'
    });
    await createTestServerMember({ serverId: club, userId: await createTestUser({ name: 'p1' }) });
    await createTestServerMember({ serverId: club, userId: await createTestUser({ name: 'p2' }) });
    await offer('Not federatable', { federatable: false });
    await offer('Not listed', { directoryListed: false });
    await offer('Closed', { allowNewUsers: false });
    // Discoverable-only servers are a local Directory matter; a peer's
    // member joins through the federated path.
    await offer('Discoverable only', { federatable: false, discoverable: true });

    const res = await postSignedAsPeer('/federation/directory', {}, peerPrivateJwk);

    expect(res.status).toBe(200);
    expect(typeof res.body?.signature).toBe('string');
    expect(res.body?.fromDomain).toBe(TEST_LOCAL_DOMAIN);
    const list = res.body?.servers as TWireRow[];
    expect(list.map((s) => s.name)).toEqual(['Chess Club']);
    expect(list[0]).toMatchObject({
      name: 'Chess Club',
      description: 'Evening games',
      tags: ['casual', 'ranked'],
      game: 'Chess',
      memberCount: 2,
      onlineCount: 0,
      logo: 'club-logo.png',
      hasPassword: true
    });
    expect(typeof list[0]!.publicId).toBe('string');
  });

  test('`limit` caps the listing (largest first); junk limits are ignored', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    const small = await offer('Small');
    const large = await offer('Large');
    await offer('Medium');
    for (const n of ['a', 'b', 'c']) {
      await createTestServerMember({ serverId: large, userId: await createTestUser({ name: n }) });
    }
    await createTestServerMember({ serverId: small, userId: await createTestUser({ name: 'd' }) });

    const two = await postSignedAsPeer('/federation/directory', { limit: 2 }, peerPrivateJwk);
    expect((two.body?.servers as TWireRow[]).map((s) => s.name)).toEqual(['Large', 'Small']);

    for (const limit of [0, -1, 1.5, '5', 5000]) {
      const res = await postSignedAsPeer('/federation/directory', { limit }, peerPrivateJwk);
      expect(res.status).toBe(200);
      expect(res.body?.servers as TWireRow[]).toHaveLength(3);
    }
  });

  test('is a signed empty list while the owner keeps the directory private', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    await offer('Chess Club');
    config.federation.exposeDirectory = false;

    const res = await postSignedAsPeer('/federation/directory', {}, peerPrivateJwk);

    expect(res.status).toBe(200);
    expect(res.body?.servers).toEqual([]);
    expect(typeof res.body?.signature).toBe('string');
  });

  test('refuses unsigned, unknown and badly signed callers', async () => {
    await initTest();
    const { peerPrivateJwk } = await seedPeer();
    await offer('Chess Club');

    const unsigned = await fetch(`${testsBaseUrl}/federation/directory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromDomain: PEER_DOMAIN })
    });
    expect(unsigned.status).toBe(400);

    const stranger = await postSignedAsPeer('/federation/directory', {}, peerPrivateJwk, 'stranger.example');
    expect(stranger.status).toBe(403);

    const { peerPrivateJwk: otherKey } = await seedPeer('other.example');
    const forged = await postSignedAsPeer('/federation/directory', {}, otherKey, PEER_DOMAIN);
    expect(forged.status).toBe(401);

    const get = await fetch(`${testsBaseUrl}/federation/directory`);
    expect(get.status).toBe(404);
  });
});
