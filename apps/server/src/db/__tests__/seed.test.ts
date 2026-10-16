import {
  DEFAULT_ROLE_PERMISSIONS,
  OWNER_ROLE_ID,
  Permission
} from '@pulse/shared';
import { describe, expect, spyOn, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { getTestDb, tdb } from '../../__tests__/setup';
import { TRUNCATE_ALL_SQL } from '../../__tests__/truncate';
import {
  categories,
  channels,
  rolePermissions,
  roles,
  servers,
  settings
} from '../schema';
import { seedDatabase } from '../seed';

// The bootstrap seed only runs against an EMPTY settings table; the
// between-test reseed (test fixture seed) has already populated it, so
// each case starts by wiping the database the way a first boot sees it.
const emptyDatabase = () => tdb.execute(TRUNCATE_ALL_SQL);

const countRows = async () => {
  const [s, srv, cat, ch, r, rp] = await Promise.all([
    tdb.select().from(settings),
    tdb.select().from(servers),
    tdb.select().from(categories),
    tdb.select().from(channels),
    tdb.select().from(roles),
    tdb.select().from(rolePermissions)
  ]);
  return {
    settings: s.length,
    servers: srv.length,
    categories: cat.length,
    channels: ch.length,
    roles: r.length,
    rolePermissions: rp.length
  };
};

describe('bootstrap seed', () => {
  test('seeds a fresh database with the ids the app relies on', async () => {
    await emptyDatabase();

    await seedDatabase();

    const [setting] = await tdb.select().from(settings);
    const serverRows = await tdb.select().from(servers);
    expect(serverRows.length).toBe(1);
    const server = serverRows[0]!;
    expect(server.id).toBe(1);
    expect(server.publicId).toBe(setting!.serverId);
    expect(server.ownerId).toBeNull();
    expect(server.secretToken).toBeTruthy();

    const categoryRows = await tdb
      .select()
      .from(categories)
      .orderBy(asc(categories.id));
    expect(categoryRows.map((c) => [c.id, c.name, c.serverId])).toEqual([
      [1, 'Text Channels', 1],
      [2, 'Voice Channels', 1]
    ]);

    const channelRows = await tdb
      .select()
      .from(channels)
      .orderBy(asc(channels.id));
    expect(channelRows.length).toBe(4);
    expect(channelRows.map((c) => [c.name, c.categoryId, c.serverId])).toEqual([
      ['General Text', 1, 1],
      ['General Text 2', 1, 1],
      ['General Voice', 2, 1],
      ['General Voice 2', 2, 1]
    ]);
    expect(new Set(channelRows.map((c) => c.publicId)).size).toBe(4);
    expect(new Set(channelRows.map((c) => c.fileAccessToken)).size).toBe(4);

    const roleRows = await tdb.select().from(roles).orderBy(asc(roles.id));
    expect(roleRows.map((r) => [r.id, r.name, r.isDefault, r.isPersistent])).toEqual([
      [OWNER_ROLE_ID, 'Owner', false, true],
      [2, 'Member', true, true]
    ]);

    const ownerPermissions = await tdb
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, OWNER_ROLE_ID));
    expect(ownerPermissions.map((p) => p.permission).sort()).toEqual(
      Object.values(Permission).sort()
    );

    const memberPermissions = await tdb
      .select({ permission: rolePermissions.permission })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, 2));
    expect(memberPermissions.map((p) => p.permission).sort()).toEqual(
      [...DEFAULT_ROLE_PERMISSIONS].sort()
    );
  });

  test('is a no-op once settings exist', async () => {
    await emptyDatabase();
    await seedDatabase();
    const first = await countRows();

    await seedDatabase();

    expect(await countRows()).toEqual(first);
  });

  test('a failure mid-seed leaves no partial rows and the next boot seeds fully', async () => {
    await emptyDatabase();

    // Fail the LAST insert of the seed (role permissions). Without the
    // transaction, settings/server/categories/channels/roles would all be
    // committed and `needsSeeding` would read false forever.
    const real = getTestDb();
    const originalTransaction = real.transaction.bind(real);
    const transactionSpy = spyOn(real, 'transaction').mockImplementation(
      ((callback: (tx: unknown) => Promise<unknown>, config?: unknown) =>
        originalTransaction(async (tx) => {
          const failing = new Proxy(tx, {
            get(target, prop, receiver) {
              if (prop === 'insert') {
                return (table: unknown) => {
                  if (table === rolePermissions) {
                    throw new Error('injected seed failure');
                  }
                  return target.insert(table as typeof roles);
                };
              }
              return Reflect.get(target, prop, receiver);
            }
          });
          return callback(failing);
        }, config as undefined)) as typeof real.transaction
    );

    try {
      await expect(seedDatabase()).rejects.toThrow('injected seed failure');
    } finally {
      transactionSpy.mockRestore();
    }

    expect(await countRows()).toEqual({
      settings: 0,
      servers: 0,
      categories: 0,
      channels: 0,
      roles: 0,
      rolePermissions: 0
    });

    // The next boot sees an empty settings table and seeds everything.
    await seedDatabase();

    const after = await countRows();
    expect(after.settings).toBe(1);
    expect(after.servers).toBe(1);
    expect(after.categories).toBe(2);
    expect(after.channels).toBe(4);
    expect(after.roles).toBe(2);
    expect(after.rolePermissions).toBe(
      Object.values(Permission).length + DEFAULT_ROLE_PERMISSIONS.length
    );
    // The rolled-back attempt consumed sequence values, but the two ids
    // the app hardcodes (bootstrap server 1, OWNER_ROLE_ID) must still
    // hold, and the sequences must sit past them so the next default
    // insert does not collide.
    const [ownerRole] = await tdb
      .select()
      .from(roles)
      .where(eq(roles.id, OWNER_ROLE_ID));
    expect(ownerRole?.name).toBe('Owner');
    const [server] = await tdb.select().from(servers).where(eq(servers.id, 1));
    expect(server?.publicId).toBeTruthy();

    const [extraRole] = await tdb
      .insert(roles)
      .values({
        name: 'Extra',
        isPersistent: false,
        isDefault: false,
        serverId: 1,
        createdAt: Date.now()
      })
      .returning({ id: roles.id });
    expect(extraRole!.id).toBeGreaterThan(2);
    const [extraServer] = await tdb
      .insert(servers)
      .values({
        name: 'Extra',
        publicId: crypto.randomUUID(),
        allowNewUsers: true,
        storageUploadEnabled: true,
        storageQuota: 1,
        storageUploadMaxFileSize: 1,
        storageSpaceQuotaByUser: 1,
        storageOverflowAction: 'x',
        enablePlugins: false,
        createdAt: Date.now()
      })
      .returning({ id: servers.id });
    expect(extraServer!.id).toBeGreaterThan(1);
  });
});
