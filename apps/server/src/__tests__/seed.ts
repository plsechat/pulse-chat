import {
  ChannelType,
  DEFAULT_ROLE_PERMISSIONS,
  OWNER_ROLE_ID,
  Permission,
  sha256,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA,
  type TICategory,
  type TIChannel,
  type TIMessage,
  type TIRole,
  type TISettings,
  type TIUser
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  categories,
  channels,
  messages,
  rolePermissions,
  roles,
  servers,
  settings,
  userRoles,
  users
} from '../db/schema';

const TEST_SECRET_TOKEN = 'test-secret-token-for-unit-tests';

const seedDatabase = async (db: PostgresJsDatabase) => {
  // Clear the in-memory supabase auth store so stale entries from a prior seed
  // don't collide with the fresh UUIDs generated below.
  globalThis.__supabaseAuthStore?.clear();

  const firstStart = Date.now();

  const initialSettings: TISettings = {
    name: 'Test Server',
    description: 'Test server description',
    password: '',
    serverId: randomUUIDv7(),
    secretToken: await sha256(TEST_SECRET_TOKEN),
    allowNewUsers: true,
    storageUploadEnabled: true,
    storageQuota: STORAGE_QUOTA,
    storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
    storageSpaceQuotaByUser: STORAGE_MIN_QUOTA_PER_USER,
    storageOverflowAction: STORAGE_OVERFLOW_ACTION,
    enablePlugins: false
  };

  await db.insert(settings).values(initialSettings);

  // Insert into servers table (mirrors settings for multi-server support)
  await db.insert(servers).values({
    name: initialSettings.name,
    description: initialSettings.description,
    password: initialSettings.password,
    publicId: initialSettings.serverId,
    secretToken: initialSettings.secretToken,
    allowNewUsers: initialSettings.allowNewUsers,
    storageUploadEnabled: initialSettings.storageUploadEnabled,
    storageQuota: initialSettings.storageQuota,
    storageUploadMaxFileSize: initialSettings.storageUploadMaxFileSize,
    storageSpaceQuotaByUser: initialSettings.storageSpaceQuotaByUser,
    storageOverflowAction: initialSettings.storageOverflowAction,
    enablePlugins: initialSettings.enablePlugins,
    createdAt: firstStart
  });

  const initialCategories: TICategory[] = [
    {
      name: 'Text Channels',
      position: 1,
      serverId: 1,
      createdAt: firstStart
    },
    {
      name: 'Voice Channels',
      position: 2,
      serverId: 1,
      createdAt: firstStart
    }
  ];

  await db.insert(categories).values(initialCategories);

  const initialChannels: TIChannel[] = [
    {
      type: ChannelType.TEXT,
      name: 'General',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 1,
      serverId: 1,
      topic: 'General text channel',
      createdAt: firstStart
    },
    {
      type: ChannelType.VOICE,
      name: 'Voice',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 2,
      serverId: 1,
      topic: 'General voice channel',
      createdAt: firstStart
    }
  ];

  await db.insert(channels).values(initialChannels);

  const ownerRole: TIRole = {
    id: OWNER_ROLE_ID,
    name: 'Owner',
    color: '#ff0000',
    isPersistent: true,
    isDefault: false,
    serverId: 1,
    createdAt: firstStart
  };

  await db.insert(roles).values(ownerRole);

  // Advance the roles sequence past the explicitly-set OWNER_ROLE_ID
  // so the next DEFAULT insert doesn't conflict
  await db.execute(sql`SELECT setval('roles_id_seq', ${OWNER_ROLE_ID})`);

  const ownerPermissions = Object.values(Permission).map((permission) => ({
    roleId: OWNER_ROLE_ID,
    permission,
    createdAt: firstStart
  }));

  await db.insert(rolePermissions).values(ownerPermissions);

  const defaultRole: TIRole = {
    name: 'Member',
    color: '#99aab5',
    isPersistent: true,
    isDefault: true,
    serverId: 1,
    createdAt: firstStart
  };

  const [insertedDefaultRole] = await db
    .insert(roles)
    .values(defaultRole)
    .returning();

  const defaultPermissions = DEFAULT_ROLE_PERMISSIONS.map((permission) => ({
    roleId: insertedDefaultRole!.id,
    permission,
    createdAt: firstStart
  }));

  await db.insert(rolePermissions).values(defaultPermissions);

  const guestRole: TIRole = {
    name: 'Guest',
    color: '#95a5a6',
    isPersistent: false,
    isDefault: false,
    serverId: 1,
    createdAt: firstStart
  };

  await db.insert(roles).values(guestRole);

  const ownerUser: TIUser = {
    name: 'Test Owner',
    supabaseId: `test-owner-${randomUUIDv7()}`,
    publicId: randomUUIDv7(),
    avatarId: null,
    bannerId: null,
    bio: null,
    bannerColor: null,
    createdAt: firstStart
  };

  const [insertedOwner] = await db.insert(users).values(ownerUser).returning();

  await db.insert(userRoles).values({
    userId: insertedOwner!.id,
    roleId: OWNER_ROLE_ID,
    createdAt: firstStart
  });

  // Set the owner on the server so hasChannelPermission owner bypass works
  await db
    .update(servers)
    .set({ ownerId: insertedOwner!.id })
    .where(sql`id = 1`);

  const regularUser: TIUser = {
    name: 'Test User',
    supabaseId: `test-user-${randomUUIDv7()}`,
    publicId: randomUUIDv7(),
    avatarId: null,
    bannerId: null,
    bio: null,
    bannerColor: null,
    createdAt: firstStart
  };

  const [insertedUser] = await db.insert(users).values(regularUser).returning();

  await db.insert(userRoles).values({
    userId: insertedUser!.id,
    roleId: insertedDefaultRole!.id,
    createdAt: firstStart
  });

  const testMessage: TIMessage = {
    userId: insertedOwner!.id,
    channelId: 1,
    content: 'Test message',
    metadata: null,
    createdAt: firstStart
  };

  await db.insert(messages).values(testMessage);

  // Pre-seed the supabase auth store so login/upload tests can authenticate.
  // The upload & public & others tests call login('testowner', 'password123')
  // and login tests call login('testowner@pulse.local', 'password123').
  const store = globalThis.__supabaseAuthStore;
  if (store) {
    store.set('testowner', {
      supabaseId: ownerUser.supabaseId,
      password: 'password123',
      email: 'testowner'
    });
    store.set('testowner@pulse.local', {
      supabaseId: ownerUser.supabaseId,
      password: 'password123',
      email: 'testowner@pulse.local'
    });
  }

  return {
    settings: initialSettings,
    owner: insertedOwner!,
    user: insertedUser!,
    ownerRole,
    defaultRole: insertedDefaultRole!,
    categories: initialCategories,
    channels: initialChannels,
    originalToken: TEST_SECRET_TOKEN
  };
};

export { seedDatabase, TEST_SECRET_TOKEN };
