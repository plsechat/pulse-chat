import {
  ChannelType,
  Permission,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import {
  categories,
  channels,
  rolePermissions,
  roles,
  serverMembers,
  servers,
  userRoles,
  users
} from '../db/schema';
import { getTestDb } from './mock-db';

/**
 * Drizzle-typed test fixtures. Use these instead of raw `INSERT INTO ...`
 * SQL — the column lists in raw SQL go stale silently when the schema
 * changes, and the lowercase ChannelType literal `'text'` slipped past
 * tests that should have failed the enum check.
 *
 * Each helper returns the inserted row's id (or the row when callers need
 * more), and uses sensible defaults for fields tests don't care about.
 */

interface CreateTestServerArgs {
  name?: string;
  ownerId?: number | null;
}

const createTestServer = async (
  args: CreateTestServerArgs = {}
): Promise<number> => {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(servers)
    .values({
      name: args.name ?? `Test Server ${randomUUIDv7().slice(0, 8)}`,
      description: '',
      password: '',
      publicId: randomUUIDv7(),
      secretToken: randomUUIDv7(),
      ownerId: args.ownerId ?? null,
      allowNewUsers: true,
      storageUploadEnabled: true,
      storageQuota: STORAGE_QUOTA,
      storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
      storageSpaceQuotaByUser: STORAGE_MIN_QUOTA_PER_USER,
      storageOverflowAction: STORAGE_OVERFLOW_ACTION,
      enablePlugins: false,
      createdAt: now
    })
    .returning({ id: servers.id });
  return row!.id;
};

interface CreateTestCategoryArgs {
  serverId: number;
  name?: string;
  position?: number;
}

const createTestCategory = async (
  args: CreateTestCategoryArgs
): Promise<number> => {
  const tdb = getTestDb();
  const [row] = await tdb
    .insert(categories)
    .values({
      name: args.name ?? 'Category',
      position: args.position ?? 0,
      serverId: args.serverId,
      createdAt: Date.now()
    })
    .returning({ id: categories.id });
  return row!.id;
};

interface CreateTestChannelArgs {
  serverId: number;
  categoryId?: number;
  name?: string;
  type?: ChannelType;
  e2ee?: boolean;
  position?: number;
}

const createTestChannel = async (
  args: CreateTestChannelArgs
): Promise<number> => {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(channels)
    .values({
      type: args.type ?? ChannelType.TEXT,
      name: args.name ?? 'channel',
      position: args.position ?? 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: now,
      categoryId: args.categoryId,
      serverId: args.serverId,
      e2ee: args.e2ee ?? false,
      createdAt: now
    })
    .returning({ id: channels.id });
  return row!.id;
};

interface CreateTestRoleArgs {
  serverId: number;
  name?: string;
  permissions?: Permission[];
  isPersistent?: boolean;
  isDefault?: boolean;
}

const createTestRole = async (args: CreateTestRoleArgs): Promise<number> => {
  const tdb = getTestDb();
  const now = Date.now();
  const [row] = await tdb
    .insert(roles)
    .values({
      name: args.name ?? 'Role',
      color: '#ff0000',
      isPersistent: args.isPersistent ?? false,
      isDefault: args.isDefault ?? false,
      serverId: args.serverId,
      createdAt: now
    })
    .returning({ id: roles.id });

  if (args.permissions && args.permissions.length > 0) {
    await tdb.insert(rolePermissions).values(
      args.permissions.map((permission) => ({
        roleId: row!.id,
        permission,
        createdAt: now
      }))
    );
  }

  return row!.id;
};

interface CreateTestServerMemberArgs {
  serverId: number;
  userId: number;
  position?: number;
}

const createTestServerMember = async (args: CreateTestServerMemberArgs) => {
  const tdb = getTestDb();
  await tdb.insert(serverMembers).values({
    serverId: args.serverId,
    userId: args.userId,
    joinedAt: Date.now(),
    position: args.position ?? 0
  });
};

interface CreateTestUserArgs {
  name?: string;
  banned?: boolean;
  supabaseId?: string;
}

const createTestUser = async (args: CreateTestUserArgs = {}): Promise<number> => {
  const tdb = getTestDb();
  const [row] = await tdb
    .insert(users)
    .values({
      name: args.name ?? `user-${randomUUIDv7().slice(0, 8)}`,
      supabaseId: args.supabaseId ?? `test-user-${randomUUIDv7()}`,
      publicId: randomUUIDv7(),
      banned: args.banned ?? false,
      createdAt: Date.now()
    })
    .returning({ id: users.id });
  return row!.id;
};

const grantTestUserRole = async (userId: number, roleId: number) => {
  const tdb = getTestDb();
  await tdb.insert(userRoles).values({
    userId,
    roleId,
    createdAt: Date.now()
  });
};

export {
  createTestCategory,
  createTestChannel,
  createTestRole,
  createTestServer,
  createTestServerMember,
  createTestUser,
  grantTestUserRole
};
