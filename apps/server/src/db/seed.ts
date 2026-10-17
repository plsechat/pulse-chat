import {
  ChannelType,
  DEFAULT_ROLE_PERMISSIONS,
  OWNER_ROLE_ID,
  Permission,
  STORAGE_MAX_FILE_SIZE,
  STORAGE_MIN_QUOTA_PER_USER,
  STORAGE_OVERFLOW_ACTION,
  STORAGE_QUOTA
} from '@pulse/shared';
import type { TISettings } from '../types';
import { randomUUIDv7 } from 'bun';
import chalk from 'chalk';
import { sql } from 'drizzle-orm';
import { logger } from '../logger';
import { db } from './index';
import { insertDefaultRosterTemplates } from './queries/event-templates';
import {
  categories,
  channels,
  rolePermissions,
  roles,
  servers,
  settings
} from './schema';

// The bootstrap server's id is a contract: http/register-user.ts claims
// ownership of `servers[id=1]` for the first registrant, and OWNER_ROLE_ID
// is the role it grants. Both rows are inserted with explicit ids (and the
// sequences bumped past them) so the contract holds even when an earlier,
// rolled-back seed attempt already consumed sequence values.
const BOOTSTRAP_SERVER_ID = 1;

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

  // One transaction for the whole seed. `needsSeeding` keys off the
  // settings row, so a crash between that insert and the last role
  // permission (slow first boot, container stop) would otherwise leave an
  // instance that never seeds again: no server, no channels, no owner
  // role slot, and only manual SQL to recover. Child rows take the ids
  // RETURNING hands back instead of assuming 1/2; only the two rows whose
  // ids are an app-level contract (see BOOTSTRAP_SERVER_ID) are pinned.
  await db.transaction(async (tx) => {
    await tx.insert(settings).values(initialSettings);

    // servers.secret_token is the per-server HMAC seed used by
    // files-crypto for short-lived file access tokens. Generate a fresh
    // random value on first boot.
    const [server] = await tx
      .insert(servers)
      .values({
        id: BOOTSTRAP_SERVER_ID,
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
      })
      .returning({ id: servers.id });
    const serverId = server!.id;
    await tx.execute(
      sql`SELECT setval(pg_get_serial_sequence('servers', 'id'), ${serverId})`
    );

    const [textCategory] = await tx
      .insert(categories)
      .values({
        name: 'Text Channels',
        position: 1,
        serverId,
        createdAt: firstStart
      })
      .returning({ id: categories.id });

    const [voiceCategory] = await tx
      .insert(categories)
      .values({
        name: 'Voice Channels',
        position: 2,
        serverId,
        createdAt: firstStart
      })
      .returning({ id: categories.id });

    const channel = (
      type: ChannelType,
      name: string,
      topic: string,
      position: number,
      categoryId: number
    ) => ({
      type,
      name,
      topic,
      position,
      categoryId,
      serverId,
      fileAccessToken: randomUUIDv7(),
      fileAccessTokenUpdatedAt: firstStart,
      publicId: randomUUIDv7(),
      createdAt: firstStart
    });

    await tx.insert(channels).values([
      channel(
        ChannelType.TEXT,
        'General Text',
        'General text channel',
        0,
        textCategory!.id
      ),
      channel(
        ChannelType.TEXT,
        'General Text 2',
        'General text channel 2',
        1,
        textCategory!.id
      ),
      channel(
        ChannelType.VOICE,
        'General Voice',
        'General voice channel',
        0,
        voiceCategory!.id
      ),
      channel(
        ChannelType.VOICE,
        'General Voice 2',
        'General voice channel 2',
        1,
        voiceCategory!.id
      )
    ]);

    const [ownerRole] = await tx
      .insert(roles)
      .values({
        id: OWNER_ROLE_ID,
        name: 'Owner',
        color: '#FFFFFF',
        isDefault: false,
        // Hierarchy rank: above the default role (0); custom roles slot in between.
        position: 1,
        isPersistent: true,
        serverId,
        createdAt: firstStart
      })
      .returning({ id: roles.id });
    await tx.execute(
      sql`SELECT setval(pg_get_serial_sequence('roles', 'id'), ${OWNER_ROLE_ID})`
    );

    const [memberRole] = await tx
      .insert(roles)
      .values({
        name: 'Member',
        color: '#FFFFFF',
        isPersistent: true,
        isDefault: true,
        serverId,
        createdAt: firstStart
      })
      .returning({ id: roles.id });

    await tx.insert(rolePermissions).values([
      // Owner: every permission.
      ...Object.values(Permission).map((permission) => ({
        roleId: ownerRole!.id,
        permission,
        createdAt: firstStart
      })),
      // Member: the default set.
      ...DEFAULT_ROLE_PERMISSIONS.map((permission) => ({
        roleId: memberRole!.id,
        permission,
        createdAt: firstStart
      }))
    ]);

    // Stock raid rosters for the bootstrap server, same set a created
    // server gets (routers/servers/create.ts).
    await insertDefaultRosterTemplates(tx, serverId, firstStart);
  });

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
