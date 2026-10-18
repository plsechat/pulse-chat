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
  friendships,
  rolePermissions,
  roles,
  serverMembers,
  servers,
  userRoles,
  users
} from '../db/schema';
import { VoiceRuntime } from '../runtimes/voice';
import { getTestDb } from './mock-db';
import { testsBaseUrl } from './setup';

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
      publicId: randomUUIDv7(),
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

/**
 * A TEXT channel with no seeded messages in the bootstrap server.
 * Exact-count tests need one: seeded channel 1 carries a message and
 * channel 2 is the VOICE channel, which no longer accepts messages.
 */
const createEmptyTextChannel = async (name: string) => {
  const [channel] = await getTestDb()
    .insert(channels)
    .values({
      type: ChannelType.TEXT,
      name,
      position: 50,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      publicId: randomUUIDv7(),
      categoryId: 1,
      serverId: 1,
      createdAt: Date.now()
    })
    .returning();

  return channel!;
};

/** A VOICE channel (no category) in `serverId`; returns the full row. */
const insertVoiceChannel = async (serverId = 1) => {
  const [channel] = await getTestDb()
    .insert(channels)
    .values({
      type: ChannelType.VOICE,
      name: `voice-${randomUUIDv7()}`,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      position: 999,
      serverId,
      publicId: randomUUIDv7(),
      createdAt: Date.now()
    })
    .returning();
  return channel!;
};

/** A second server next to the bootstrap one; returns the full row. */
const insertOtherServer = async () => {
  const [server] = await getTestDb()
    .insert(servers)
    .values({
      name: `Other Server ${randomUUIDv7().slice(0, 8)}`,
      publicId: randomUUIDv7(),
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
  return server!;
};

/** A fresh local user who is a plain member of the bootstrap server. */
const insertMemberUser = async () => {
  const tdb = getTestDb();
  const suffix = randomUUIDv7();
  const [user] = await tdb
    .insert(users)
    .values({
      supabaseId: `member-supa-${suffix}`,
      name: `MemberUser-${suffix.slice(0, 8)}`,
      publicId: `member-pid-${suffix}`,
      createdAt: Date.now()
    })
    .returning();

  await tdb.insert(serverMembers).values({
    userId: user!.id,
    serverId: 1,
    nickname: null,
    joinedAt: Date.now()
  });

  return user!;
};

/**
 * Stage a user as "in voice" by constructing the runtime directly.
 * Voice runtimes are pure in-memory state (router creation only happens
 * on real joins), and the module-level runtime map is NOT reset by the
 * between-test TRUNCATE — callers must destroy what they create.
 */
const stageUserInVoice = (channelId: number, userId: number) => {
  const runtime = new VoiceRuntime(channelId);
  runtime.addUser(userId, { micMuted: false, soundMuted: false });
  return runtime;
};

/** A local (non-federated) user who is already friends with user 1. */
const seedLocalFriend = async (name = 'localFriend'): Promise<number> => {
  const tdb = getTestDb();
  const [local] = await tdb
    .insert(users)
    .values({
      supabaseId: `local-${name}`,
      name,
      publicId: `local-pid-${name}`,
      isFederated: false,
      createdAt: Date.now()
    })
    .returning();
  await tdb.insert(friendships).values({
    userId: 1,
    friendId: local!.id,
    createdAt: Date.now()
  });
  return local!.id;
};

/** POST /auth/provision with a bearer token (session bootstrap). */
const provision = (token: string, body?: { invite?: string }) =>
  fetch(`${testsBaseUrl}/auth/provision`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(body ?? {})
  });

export {
  createEmptyTextChannel,
  createTestCategory,
  createTestChannel,
  createTestRole,
  createTestServer,
  createTestServerMember,
  createTestUser,
  grantTestUserRole,
  insertMemberUser,
  insertOtherServer,
  insertVoiceChannel,
  provision,
  seedLocalFriend,
  stageUserInVoice
};
