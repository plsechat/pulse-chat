/**
 * Public directory — opt-in (others.updateSettings), the Directory
 * listing (servers.directory / directoryGames) and the instance owner's
 * exposure switch (admin.getRegistration / setRegistration).
 *
 * Setup is inline per test (no beforeEach — it deadlocks against the
 * global TRUNCATE).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { config } from '../../config';
import { seedPeerInstance } from '../../__tests__/federation-fixtures';
import { setDirectoryExposed } from '../../utils/directory-config';
import { setOnlineUserIdsProvider } from '../../utils/ws-stats';
import {
  createTestServer,
  createTestServerMember,
  createTestUser
} from '../../__tests__/fixtures';
import { initTest } from '../../__tests__/helpers';
import { getTestDb } from '../../__tests__/mock-db';
import { directoryCache, federationInstances, servers } from '../../db/schema';

const tdb = () => getTestDb();

/** A server with an open join path, listed with the given card copy. */
const listServer = async (
  name: string,
  card: {
    game?: string | null;
    tags?: string[];
    description?: string | null;
    discoverable?: boolean;
    allowNewUsers?: boolean;
    listed?: boolean;
  } = {}
) => {
  const id = await createTestServer({ name, ownerId: 1 });
  await tdb()
    .update(servers)
    .set({
      directoryListed: card.listed ?? true,
      discoverable: card.discoverable ?? true,
      allowNewUsers: card.allowNewUsers ?? true,
      directoryGame: card.game ?? null,
      directoryTags: card.tags ?? [],
      directoryDescription: card.description ?? null
    })
    .where(eq(servers.id, id));
  return id;
};

const cacheRow = (
  instanceId: number,
  row: {
    publicId: string;
    name: string;
    game?: string | null;
    tags?: string[];
    memberCount?: number;
    onlineCount?: number;
    hasPassword?: boolean;
  }
) =>
  tdb()
    .insert(directoryCache)
    .values({
      instanceId,
      serverPublicId: row.publicId,
      name: row.name,
      game: row.game ?? null,
      tags: row.tags ?? [],
      description: null,
      memberCount: row.memberCount ?? 0,
      onlineCount: row.onlineCount ?? 0,
      logoUrl: null,
      hasPassword: row.hasPassword ?? false,
      fetchedAt: Date.now()
    });

afterEach(() => {
  config.federation.exposeDirectory = true;
  setOnlineUserIdsProvider(() => []);
});

describe('directory opt-in (others.updateSettings)', () => {
  test('listing needs an open join path, checked on the resulting state', async () => {
    const { caller } = await initTest(1);

    // Server 1 is not discoverable by default.
    await expect(
      caller.others.updateSettings({ serverId: 1, directoryListed: true })
    ).rejects.toThrow(/discoverable and accepting new members/);

    await caller.others.updateSettings({
      serverId: 1,
      directoryListed: true,
      discoverable: true,
      allowNewUsers: true,
      directoryDescription: 'Chess every evening',
      directoryTags: ['Casual', 'casual ', 'ranked'],
      directoryGame: 'Chess'
    });

    const settings = await caller.others.getSettings({ serverId: 1 });
    expect(settings.directoryListed).toBe(true);
    expect(settings.directoryDescription).toBe('Chess every evening');
    // Trimmed and deduplicated case-insensitively.
    expect(settings.directoryTags).toEqual(['Casual', 'ranked']);
    expect(settings.directoryGame).toBe('Chess');

    // Closing the join path while listed is refused …
    await expect(
      caller.others.updateSettings({ serverId: 1, discoverable: false })
    ).rejects.toThrow(/discoverable and accepting new members/);
    await expect(
      caller.others.updateSettings({ serverId: 1, allowNewUsers: false })
    ).rejects.toThrow(/discoverable and accepting new members/);

    // … unless the listing goes in the same save.
    await caller.others.updateSettings({
      serverId: 1,
      discoverable: false,
      directoryListed: false,
      directoryDescription: '',
      directoryGame: ''
    });
    const after = await caller.others.getSettings({ serverId: 1 });
    expect(after.directoryListed).toBe(false);
    expect(after.directoryDescription).toBeNull();
    expect(after.directoryGame).toBeNull();
  });

  test('card copy is bounded: description 300, five tags of 24, game 60', async () => {
    const { caller } = await initTest(1);
    await caller.others.updateSettings({ serverId: 1, discoverable: true });

    await expect(
      caller.others.updateSettings({ serverId: 1, directoryDescription: 'x'.repeat(301) })
    ).rejects.toThrow();
    await caller.others.updateSettings({ serverId: 1, directoryDescription: 'x'.repeat(300) });

    await expect(
      caller.others.updateSettings({
        serverId: 1,
        directoryTags: ['a', 'b', 'c', 'd', 'e', 'f']
      })
    ).rejects.toThrow();
    await expect(
      caller.others.updateSettings({ serverId: 1, directoryTags: ['x'.repeat(25)] })
    ).rejects.toThrow();
    await expect(
      caller.others.updateSettings({ serverId: 1, directoryTags: ['   '] })
    ).rejects.toThrow();
    await caller.others.updateSettings({
      serverId: 1,
      directoryTags: ['a', 'b', 'c', 'd', 'x'.repeat(24)]
    });

    await expect(
      caller.others.updateSettings({ serverId: 1, directoryGame: 'g'.repeat(61) })
    ).rejects.toThrow();
    await caller.others.updateSettings({ serverId: 1, directoryGame: 'g'.repeat(60) });

    const settings = await caller.others.getSettings({ serverId: 1 });
    expect(settings.directoryDescription).toHaveLength(300);
    expect(settings.directoryTags).toHaveLength(5);
    expect(settings.directoryGame).toHaveLength(60);
  });

  test('tags are letters, digits, spaces, _ and - in any script; stored without the #', async () => {
    const { caller } = await initTest(1);

    await caller.others.updateSettings({
      serverId: 1,
      directoryTags: ['casual', 'late night', 'pvp_2', 'co-op', 'Überzahl']
    });
    expect((await caller.others.getSettings({ serverId: 1 })).directoryTags).toEqual([
      'casual',
      'late night',
      'pvp_2',
      'co-op',
      'Überzahl'
    ]);

    for (const bad of ['#casual', 'a,b', 'nope!', '<b>x</b>', 'tag/slash']) {
      await expect(
        caller.others.updateSettings({ serverId: 1, directoryTags: [bad] })
      ).rejects.toThrow('letters, numbers, spaces');
    }
  });
});

describe('servers.directory', () => {
  test('lists local servers with an open join path only, with counts and the joined flag', async () => {
    const { caller } = await initTest(2);
    const listed = await listServer('Open Club', { game: 'Chess', tags: ['casual'] });
    await listServer('Hidden Club', { discoverable: false });
    await listServer('Closed Club', { allowNewUsers: false });
    await listServer('Unlisted Club', { listed: false });
    const member = await createTestUser({ name: 'clubber' });
    await createTestServerMember({ serverId: listed, userId: member });
    await createTestServerMember({ serverId: listed, userId: 2 });

    const { entries, hasMore } = await caller.servers.directory({});

    expect(hasMore).toBe(false);
    expect(entries.map((e) => e.name)).toEqual(['Open Club']);
    expect(entries[0]).toMatchObject({
      source: 'local',
      serverId: listed,
      game: 'Chess',
      tags: ['casual'],
      memberCount: 2,
      onlineCount: 0,
      hasPassword: false,
      joined: true,
      instance: null,
      fetchedAt: null
    });

    const stranger = await createTestUser({ name: 'stranger' });
    const { caller: other } = await initTest(stranger);
    const theirs = await other.servers.directory({});
    expect(theirs.entries[0]?.joined).toBe(false);

    // With people online the count is the members among them — this is
    // the branch the socket-less default never reaches, and it once
    // broke the whole listing (the id list was flattened into scalar
    // parameters, which `= ANY(…::int[])` refuses).
    setOnlineUserIdsProvider(() => [member, 2, stranger, 7, 8, 9]);
    const live = await caller.servers.directory({ sort: 'online' });
    expect(live.entries.map((e) => e.name)).toEqual(['Open Club']);
    expect(live.entries[0]?.onlineCount).toBe(2);
    const games = await caller.servers.directoryGames();
    expect(games).toEqual(['Chess']);
  });

  test('merges active peers\' cached listings; search, game filter and sorts apply to both', async () => {
    const { caller } = await initTest(1);
    const peer = await seedPeerInstance('peer.example');
    const blocked = await seedPeerInstance('blocked.example');
    await tdb()
      .update(federationInstances)
      .set({ status: 'blocked' })
      .where(eq(federationInstances.id, blocked));

    const big = await listServer('Local Chess', { game: 'Chess', tags: ['ranked'] });
    for (const name of ['m1', 'm2', 'm3']) {
      await createTestServerMember({
        serverId: big,
        userId: await createTestUser({ name })
      });
    }
    await listServer('Local Go', { game: 'Go' });
    await cacheRow(peer, {
      publicId: 'remote-chess',
      name: 'Remote Chess Club',
      game: 'chess',
      tags: ['casual'],
      memberCount: 50,
      onlineCount: 5
    });
    await cacheRow(peer, { publicId: 'remote-quiet', name: 'Remote Quiet', game: 'Trivia', memberCount: 2, hasPassword: true });
    await cacheRow(blocked, { publicId: 'blocked-1', name: 'Blocked Peer Server', memberCount: 999, onlineCount: 99 });

    // Default sort: online first, then members, then name.
    const byOnline = await caller.servers.directory({});
    expect(byOnline.entries.map((e) => e.name)).toEqual([
      'Remote Chess Club',
      'Local Chess',
      'Remote Quiet',
      'Local Go'
    ]);
    const remote = byOnline.entries[0]!;
    expect(remote).toMatchObject({
      source: 'federated',
      serverId: null,
      publicId: 'remote-chess',
      instance: { id: peer, domain: 'peer.example', name: 'peer.example' },
      hasPassword: false,
      joined: false
    });
    expect(typeof remote.fetchedAt).toBe('number');
    // The peer's password flag rides along so the card asks before the join.
    expect(byOnline.entries.find((e) => e.publicId === 'remote-quiet')?.hasPassword).toBe(true);

    const byMembers = await caller.servers.directory({ sort: 'members' });
    expect(byMembers.entries.map((e) => e.name)).toEqual([
      'Remote Chess Club',
      'Local Chess',
      'Remote Quiet',
      'Local Go'
    ]);

    const byName = await caller.servers.directory({ sort: 'name' });
    expect(byName.entries.map((e) => e.name)).toEqual([
      'Local Chess',
      'Local Go',
      'Remote Chess Club',
      'Remote Quiet'
    ]);

    // Search covers name, game and tags, case-insensitively.
    const chess = await caller.servers.directory({ search: 'chess' });
    expect(chess.entries.map((e) => e.name).sort()).toEqual(['Local Chess', 'Remote Chess Club']);
    const casual = await caller.servers.directory({ search: 'CASUAL' });
    expect(casual.entries.map((e) => e.name)).toEqual(['Remote Chess Club']);
    const trivia = await caller.servers.directory({ search: 'trivia' });
    expect(trivia.entries.map((e) => e.name)).toEqual(['Remote Quiet']);
    // LIKE metacharacters are literal.
    const wildcard = await caller.servers.directory({ search: '%' });
    expect(wildcard.entries).toEqual([]);

    // Game filter is exact, case-insensitive.
    const byGame = await caller.servers.directory({ game: 'CHESS' });
    expect(byGame.entries.map((e) => e.name)).toEqual(['Remote Chess Club', 'Local Chess']);

    // Games for the filter: distinct, first spelling wins, sorted.
    expect(await caller.servers.directoryGames()).toEqual(['Chess', 'Go', 'Trivia']);
  });

  test('pages with hasMore and refuses out-of-bounds input', async () => {
    const { caller } = await initTest(1);
    await listServer('A Club');
    await listServer('B Club');
    await listServer('C Club');

    const first = await caller.servers.directory({ sort: 'name', limit: 2 });
    expect(first.entries.map((e) => e.name)).toEqual(['A Club', 'B Club']);
    expect(first.hasMore).toBe(true);
    const second = await caller.servers.directory({ sort: 'name', limit: 2, offset: 2 });
    expect(second.entries.map((e) => e.name)).toEqual(['C Club']);
    expect(second.hasMore).toBe(false);

    await expect(caller.servers.directory({ limit: 101 })).rejects.toThrow();
    await expect(caller.servers.directory({ limit: 0 })).rejects.toThrow();
    await expect(caller.servers.directory({ offset: 950, limit: 100 })).rejects.toThrow();
    await expect(caller.servers.directory({ search: 'x'.repeat(65) })).rejects.toThrow();
    await expect(caller.servers.directory({ game: 'x'.repeat(61) })).rejects.toThrow();
    // @ts-expect-error — the sort is an enum
    await expect(caller.servers.directory({ sort: 'random' })).rejects.toThrow();
  });
});

describe('directory exposure switch (admin.getRegistration / setRegistration)', () => {
  test('the instance owner reads and flips it; it only takes effect with federation on', async () => {
    const { caller } = await initTest(1);
    const enabledBefore = config.federation.enabled;
    try {
      config.federation.enabled = true;
      let reg = await caller.admin.getRegistration();
      expect(reg.directory).toEqual({ exposed: true, federationEnabled: true, effective: true });

      await caller.admin.setRegistration({ exposeDirectory: false });
      expect(config.federation.exposeDirectory).toBe(false);
      reg = await caller.admin.getRegistration();
      expect(reg.directory).toEqual({ exposed: false, federationEnabled: true, effective: false });

      await caller.admin.setRegistration({ exposeDirectory: true });
      config.federation.enabled = false;
      reg = await caller.admin.getRegistration();
      expect(reg.directory).toEqual({ exposed: true, federationEnabled: false, effective: false });

      // Registration itself is untouched by a directory-only save.
      const allowBefore = reg.allowNewUsers;
      await caller.admin.setRegistration({ exposeDirectory: false });
      expect((await caller.admin.getRegistration()).allowNewUsers).toBe(allowBefore);
    } finally {
      config.federation.enabled = enabledBefore;
      // The route persists to config.ini; put the default back on disk
      // too, so an interrupted run cannot leak "off" into the next boot.
      await setDirectoryExposed(true);
    }
  });

  test('a server owner who is not the instance owner is refused', async () => {
    const outsider = await createTestUser({ name: 'not-the-operator' });
    const { caller } = await initTest(outsider);
    await expect(
      caller.admin.setRegistration({ exposeDirectory: false })
    ).rejects.toThrow(/instance owner/);
    expect(config.federation.exposeDirectory).toBe(true);
  });
});
