import {
  ChannelType,
  DEFAULT_ROLE_PERMISSIONS,
  Permission,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA,
  type TICategory,
  type TIChannel,
  type TIRole,
  type TISettings
} from '@pulse/shared';
import { randomUUIDv7 } from 'bun';
import chalk from 'chalk';
import { logger } from '../logger';
import { db } from './index';
import {
  categories,
  channels,
  rolePermissions,
  roles,
  servers,
  settings
} from './schema';

const seedDatabase = async () => {
  const needsSeeding = (await db.select().from(settings)).length === 0;

  if (!needsSeeding) return;

  logger.debug('Seeding initial database values...');

  const firstStart = Date.now();

  const initialSettings: TISettings = {
    name: 'Pulse Server',
    description:
      'This is the default Pulse server description. Change me in the server settings!',
    password: '',
    serverId: Bun.randomUUIDv7(),
    allowNewUsers: true,
    storageUploadEnabled: true,
    storageQuota: STORAGE_QUOTA,
    storageUploadMaxFileSize: STORAGE_MAX_FILE_SIZE,
    storageSpaceQuotaByUser: STORAGE_MIN_QUOTA_PER_USER,
    storageOverflowAction: STORAGE_OVERFLOW_ACTION,
    enablePlugins: false
  };

  await db.insert(settings).values(initialSettings);

  // servers.secret_token is the per-server HMAC seed used by files-crypto
  // for short-lived file access tokens — unrelated to the (now-removed)
  // owner-claim flow. Generate a fresh random value on first boot.
  await db.insert(servers).values({
    name: initialSettings.name,
    description: initialSettings.description,
    password: initialSettings.password,
    publicId: initialSettings.serverId,
    secretToken: randomUUIDv7(),
    allowNewUsers: initialSettings.allowNewUsers,
    storageUploadEnabled: initialSettings.storageUploadEnabled,
    storageQuota: initialSettings.storageQuota,
    storageUploadMaxFileSize: initialSettings.storageUploadMaxFileSize,
    storageSpaceQuotaByUser: initialSettings.storageSpaceQuotaByUser,
    storageOverflowAction: initialSettings.storageOverflowAction,
    enablePlugins: initialSettings.enablePlugins,
    discoverable: true,
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

  const initialChannels: TIChannel[] = [
    {
      type: ChannelType.TEXT,
      name: 'General Text',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 1,
      serverId: 1,
      topic: 'General text channel',
      createdAt: firstStart
    },
    {
      type: ChannelType.TEXT,
      name: 'General Text 2',
      position: 1,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 1,
      serverId: 1,
      topic: 'General text channel 2',
      createdAt: firstStart
    },
    {
      type: ChannelType.VOICE,
      name: 'General Voice',
      position: 0,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 2,
      serverId: 1,
      topic: 'General voice channel',
      createdAt: firstStart
    },
    {
      type: ChannelType.VOICE,
      name: 'General Voice 2',
      position: 1,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: Date.now(),
      categoryId: 2,
      serverId: 1,
      topic: 'General voice channel 2',
      createdAt: firstStart
    }
  ];

  const initialRoles: TIRole[] = [
    {
      name: 'Owner',
      color: '#FFFFFF',
      isDefault: false,
      isPersistent: true,
      serverId: 1,
      createdAt: firstStart
    },
    {
      name: 'Member',
      color: '#FFFFFF',
      isPersistent: true,
      isDefault: true,
      serverId: 1,
      createdAt: firstStart
    }
  ];

  const initialRolePermissions: {
    [roleId: number]: Permission[];
  } = {
    1: Object.values(Permission), // Owner (all permissions)
    2: DEFAULT_ROLE_PERMISSIONS // Member (default permissions)
  };

  await db.insert(categories).values(initialCategories);
  await db.insert(channels).values(initialChannels);
  await db.insert(roles).values(initialRoles);

  for (const [roleId, permissions] of Object.entries(initialRolePermissions)) {
    for (const permission of permissions) {
      await db.insert(rolePermissions).values({
        roleId: Number(roleId),
        permission,
        createdAt: Date.now()
      });
    }
  }

  const notice = [
    chalk.redBright.bold('I M P O R T A N T'),
    chalk.dim('────────────────────────────────────────────────────'),
    chalk.whiteBright('This server has been started for the first time.'),
    chalk.whiteBright(
      'The first user to register will automatically become the server Owner.'
    ),
    chalk.yellowBright('────────────────────────────────────────────────────')
  ].join('\n');

  logger.warn(notice);
};

export { seedDatabase };
