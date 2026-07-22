/**
 * Instance admin router — every procedure is instanceOwnerProcedure
 * (bootstrap-server owner = seeded user 1). Setup is done inline in
 * each test (no beforeEach) to avoid piling row inserts onto the global
 * setup.ts TRUNCATE in a way that competes with parallel test files for
 * table-level locks.
 */

import {
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { serverMembers, servers, settings, users } from '../../db/schema';
import { initTest } from '../../__tests__/helpers';

const insertMemberUser = async () => {
  const suffix = randomUUIDv7();
  const [user] = await db
    .insert(users)
    .values({
      supabaseId: `admin-supa-${suffix}`,
      name: `AdminTestUser-${suffix.slice(0, 8)}`,
      publicId: `admin-pid-${suffix}`,
      createdAt: Date.now()
    })
    .returning();

  await db.insert(serverMembers).values({
    userId: user!.id,
    serverId: 1,
    nickname: null,
    joinedAt: Date.now()
  });

  return user!;
};

describe('admin router', () => {
  test('every admin procedure is refused for a non-owner', async () => {
    const { caller } = await initTest(2);

    await expect(caller.admin.listUsers({})).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(
      caller.admin.banUser({ userId: 3, reason: 'nope' })
    ).rejects.toThrow('Only the instance owner');
    await expect(caller.admin.getRegistration()).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.deleteUser({ userId: 3 })).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.listServers()).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.getHealth()).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.getActivityLog({})).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.getStorage()).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.runStorageCleanup()).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.getRecentLogs({})).rejects.toThrow(
      'Only the instance owner'
    );
    await expect(caller.admin.getMetrics({})).rejects.toThrow(
      'Only the instance owner'
    );
  });

  test('getMetrics serves the sampler ring', async () => {
    const { caller } = await initTest();

    // The interval sampler doesn't run under tests — seed the ring.
    const { collectMetricsSample } = await import('../../utils/metrics');
    await collectMetricsSample(3);
    const { intervalMs, samples } = await caller.admin.getMetrics({});
    expect(intervalMs).toBeGreaterThan(0);
    expect(samples.length).toBeGreaterThanOrEqual(1);
    const last = samples[samples.length - 1]!;
    expect(last.rssBytes).toBeGreaterThan(0);
    expect(last.cpuProcessPercent).toBeGreaterThanOrEqual(0);
    expect(last.elLagMs).toBe(3);
    expect(typeof last.netRxBps).toBe('number');
  });

  test('observability routes return live shapes for the owner', async () => {
    const { caller } = await initTest();

    const health = await caller.admin.getHealth();
    expect(health.version.length).toBeGreaterThan(0);
    expect(health.bunVersion.length).toBeGreaterThan(0);
    expect(health.uptimeMs).toBeGreaterThan(0);
    expect(health.memory.rss).toBeGreaterThan(0);
    expect(health.database.sizeBytes).toBeGreaterThan(0);
    expect(health.database.users).toBeGreaterThanOrEqual(1);
    expect(health.database.servers).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(health.federation)).toBe(true);

    // joinServer in initTest writes SERVER_STARTED/USER_* rows via the
    // async activity queue; seed one row directly so the assertion
    // never races the drain.
    const { activityLog } = await import('../../db/schema');
    await db.insert(activityLog).values({
      userId: 1,
      type: 'USER_BANNED',
      details: { reason: 'obs-test', bannedBy: 1 },
      createdAt: Date.now()
    });
    const log = await caller.admin.getActivityLog({ type: undefined });
    expect(log.total).toBeGreaterThanOrEqual(1);
    const filtered = await caller.admin.getActivityLog({
      type: 'USER_BANNED' as never
    });
    expect(
      filtered.entries.every((e) => e.type === 'USER_BANNED')
    ).toBe(true);
    expect(typeof filtered.entries[0]!.userName).toBe('string');

    const storage = await caller.admin.getStorage();
    expect(storage.totalBytes).toBeGreaterThanOrEqual(0);
    expect(storage.orphanCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(storage.topUploaders)).toBe(true);

    const cleanup = await caller.admin.runStorageCleanup();
    expect(cleanup.removed).toBeGreaterThanOrEqual(0);

    const { logger } = await import('../../logger');
    logger.info('observability-probe line');
    const logs = await caller.admin.getRecentLogs({});
    expect(
      logs.logs.some((l) => l.message.includes('observability-probe line'))
    ).toBe(true);
    const errorsOnly = await caller.admin.getRecentLogs({ level: 'error' });
    expect(errorsOnly.logs.every((l) => l.level === 'error')).toBe(true);
  });

  test('listServers returns every server with owner and counts', async () => {
    const { caller } = await initTest();

    const list = await caller.admin.listServers();
    const seeded = list.find((s) => s.id === 1);
    expect(seeded).toBeDefined();
    expect(seeded!.memberCount).toBeGreaterThanOrEqual(1);
    expect(seeded!.channelCount).toBeGreaterThanOrEqual(1);
    expect(typeof seeded!.ownerName).toBe('string');
  });

  test('getServerInfo returns content counts and 404s on a missing server', async () => {
    const { caller } = await initTest();

    const details = await caller.admin.getServerInfo({ serverId: 1 });
    expect(details.roleCount).toBeGreaterThanOrEqual(0);
    expect(details.messageCount).toBeGreaterThanOrEqual(0);
    expect(typeof details.inviteCount).toBe('number');

    await expect(
      caller.admin.getServerInfo({ serverId: 999999 })
    ).rejects.toThrow('Server not found');
  });

  test('listUsers returns every account with search and totals', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();

    const all = await caller.admin.listUsers({});
    expect(all.total).toBeGreaterThanOrEqual(3);
    expect(all.users.some((u) => u.id === target.id)).toBe(true);

    const searched = await caller.admin.listUsers({
      search: target.name.slice(0, 20)
    });
    expect(searched.users.length).toBe(1);
    expect(searched.users[0]!.id).toBe(target.id);
    expect(searched.total).toBe(1);
  });

  test('banUser flips the instance-wide flag; repeat and self are refused', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();

    await caller.admin.banUser({ userId: target.id, reason: 'spam' });

    const [row] = await db
      .select({ banned: users.banned, banReason: users.banReason })
      .from(users)
      .where(eq(users.id, target.id));
    expect(row!.banned).toBe(true);
    expect(row!.banReason).toBe('spam');

    await expect(
      caller.admin.banUser({ userId: target.id })
    ).rejects.toThrow('already banned');
    await expect(caller.admin.banUser({ userId: 1 })).rejects.toThrow(
      'cannot ban yourself'
    );
  });

  test('unbanUser clears the flag; unbanning a non-banned user is refused', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();

    await caller.admin.banUser({ userId: target.id, reason: 'oops' });
    await caller.admin.unbanUser({ userId: target.id });

    const [row] = await db
      .select({ banned: users.banned, banReason: users.banReason })
      .from(users)
      .where(eq(users.id, target.id));
    expect(row!.banned).toBe(false);
    expect(row!.banReason).toBeNull();

    await expect(
      caller.admin.unbanUser({ userId: target.id })
    ).rejects.toThrow('not banned');
  });

  test('deleteUser tombstones the target through the shared core', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();

    await caller.admin.deleteUser({ userId: target.id });

    const [after] = await db
      .select()
      .from(users)
      .where(eq(users.id, target.id));
    expect(after!.deletedAt).toBeGreaterThan(0);
    expect(after!.name).toBe(`Deleted User ${target.publicId.slice(0, 6)}`);
    expect(after!.supabaseId).toBe(`deleted:${target.publicId}`);

    const memberships = await db
      .select()
      .from(serverMembers)
      .where(eq(serverMembers.userId, target.id));
    expect(memberships.length).toBe(0);
  });

  test('deleteUser refuses self and refuses a target that owns servers', async () => {
    const { caller } = await initTest();
    const target = await insertMemberUser();

    await expect(caller.admin.deleteUser({ userId: 1 })).rejects.toThrow(
      'cannot delete your own account'
    );

    const [owned] = await db
      .insert(servers)
      .values({
        name: 'Admin Delete Owned Server',
        publicId: randomUUIDv7(),
        ownerId: target.id,
        allowNewUsers: true,
        storageUploadEnabled: true,
        storageQuota: STORAGE_QUOTA,
        storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
        storageSpaceQuotaByUser: STORAGE_MIN_QUOTA_PER_USER,
        storageOverflowAction: STORAGE_OVERFLOW_ACTION,
        enablePlugins: false,
        createdAt: Date.now()
      })
      .returning();

    await expect(
      caller.admin.deleteUser({ userId: target.id })
    ).rejects.toThrow('still owns');

    // Cleanup so parallel expectations about server counts stay stable.
    await db.delete(servers).where(eq(servers.id, owned!.id));
  });

  test('registration toggle persists on the instance settings row', async () => {
    const { caller } = await initTest();

    const before = await caller.admin.getRegistration();
    expect(typeof before.allowNewUsers).toBe('boolean');
    expect(typeof before.methods.password).toBe('boolean');

    await caller.admin.setRegistration({ allowNewUsers: false });
    const [row] = await db
      .select({ allowNewUsers: settings.allowNewUsers })
      .from(settings)
      .limit(1);
    expect(row!.allowNewUsers).toBe(false);

    // Restore — register/login suites depend on the seeded default.
    await caller.admin.setRegistration({ allowNewUsers: true });
  });
});
