import type {
  TJoinedSettings,
  TPublicServerSettings
} from '@pulse/shared';
import { eq } from 'drizzle-orm';
import { db } from '..';
import { files, servers, settings } from '../schema';

const getSettings = async (): Promise<TJoinedSettings> => {
  const [serverSettings] = await db.select().from(settings).limit(1);

  if (!serverSettings) {
    throw new Error('Server settings not found in database');
  }

  const logo = serverSettings.logoId
    ? (
        await db
          .select()
          .from(files)
          .where(eq(files.id, serverSettings.logoId))
          .limit(1)
      )[0]
    : undefined;

  return {
    ...serverSettings,
    logo: logo ?? null
  };
};

const getServerPublicSettings = async (
  serverId: number
): Promise<TPublicServerSettings> => {
  const [server] = await db
    .select()
    .from(servers)
    .where(eq(servers.id, serverId))
    .limit(1);

  if (!server) {
    throw new Error(`Server ${serverId} not found`);
  }

  return {
    id: server.id,
    description: server.description ?? '',
    name: server.name,
    publicId: server.publicId,
    storageUploadEnabled: server.storageUploadEnabled,
    storageQuota: server.storageQuota,
    storageUploadMaxFileSize: server.storageUploadMaxFileSize,
    storageSpaceQuotaByUser: server.storageSpaceQuotaByUser,
    storageOverflowAction: server.storageOverflowAction,
    enablePlugins: server.enablePlugins
  };
};

const getPublicSettings = async (): Promise<TPublicServerSettings> => {
  // For backward compat, reads from the first server
  const [server] = await db.select().from(servers).limit(1);

  if (!server) {
    throw new Error('No server found in database');
  }

  return getServerPublicSettings(server.id);
};

// Cached token for synchronous access (used by files-crypto)
let cachedToken: string;

const getServerTokenSync = (): string => {
  if (!cachedToken) {
    throw new Error('Server token has not been initialized yet');
  }

  return cachedToken;
};

const getSecretToken = async (): Promise<string> => {
  if (cachedToken) return cachedToken;

  // Read from first server's secret token
  const [server] = await db.select().from(servers).limit(1);

  if (!server?.secretToken) {
    throw new Error('Secret token not found in database');
  }

  cachedToken = server.secretToken;

  return cachedToken;
};

const getFirstServerPassword = async (): Promise<string | null> => {
  const [server] = await db
    .select({ password: servers.password })
    .from(servers)
    .limit(1);
  return server?.password ?? null;
};

export {
  getFirstServerPassword,
  getPublicSettings,
  getSecretToken,
  getServerPublicSettings,
  getServerTokenSync,
  getSettings
};
